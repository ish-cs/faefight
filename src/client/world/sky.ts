import * as THREE from 'three/webgpu';
import { cos, float, max, min, mix, positionWorld, sin, smoothstep, step, uniform } from 'three/tsl';
import { MAP } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import { activeKeymap, bindingLabel, isAction } from '../keymap';
import { settings } from '../settings/store';
import { Lighting, type ShadowPreset, SUN_DIR as LIGHT_SUN_DIR } from './lighting';
import { buildPipeline, grade, type PostOptions, sunScreen } from './post';

export type Quality = 'low' | 'high' | 'ultra';
const QUALITIES: Quality[] = ['low', 'high', 'ultra'];

/** Persisted in Settings → Video. */
export function loadQuality(): Quality {
  return settings.get().video.quality;
}
function saveQuality(q: Quality) {
  settings.update((s) => { s.video.quality = q; });
}

export { SUN_DIR } from './lighting';

type Preset = {
  pixelRatio: number;
  /** cascaded shadow maps: count, size², shadow distance (m) */
  shadow: ShadowPreset;
  post: PostOptions;
};
// low: 2 small cascades over a short range; high: 3 cascades (crisp near, shorter reach than ultra);
// ultra: 4 cascades with a long reach. GTAO + bloom on high/ultra (AO at half resolution).
const PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 1, shadow: { cascades: 2, mapSize: 1024, far: 90 }, post: { samples: 4, bloom: false, ao: false } },
  high: { pixelRatio: 1.5, shadow: { cascades: 3, mapSize: 2048, far: 180 }, post: { samples: 4, bloom: true, ao: { resolution: 0.5, samples: 10 }, flare: true } },
  ultra: { pixelRatio: 2, shadow: { cascades: 4, mapSize: 2048, far: 300 }, post: { samples: 4, bloom: true, ao: { resolution: 0.5, samples: 16 }, flare: true } },
};

/**
 * Sky dome, image-based lighting, warm cascaded-shadow sun, aerial-perspective haze, ACES tone mapping, colour
 * grade, and (high/ultra) GTAO + bloom. Owns the frame's final draw so the post chain follows the quality preset.
 */
export class SkyLighting {
  /** the lighting rig (sun, hemisphere bounce, sky, env map, haze, weather): world/lighting.ts */
  readonly lighting: Lighting;
  readonly sun: THREE.DirectionalLight;
  /** live-tweakable grade uniforms (debug) */
  readonly grade = grade;
  /** haze uniforms (debug) */
  readonly haze: { color: Lighting['u']['hazeColor']; sunColor: Lighting['u']['hazeSunColor']; density: Lighting['u']['hazeDensity']; heightFalloff: Lighting['u']['hazeHeightFalloff'] };
  /** bunker interiors (x, groundY, z, yaw) - up to 8; parked far away until setMap */
  private interiors = Array.from({ length: 8 }, () => uniform(new THREE.Vector4(1e6, 0, 1e6, 0)));
  private interiorAO = this.buildInteriorAO();
  quality: Quality;
  /** Settings / Video resolution scale: multiplies the preset's pixel ratio (result clamped to 0.5-2). */
  private resScale = settings.get().video.resolutionScale;
  private pipeline: THREE.RenderPipeline | null = null;
  private sunTmp = new THREE.Vector3();

  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera) {
    this.quality = loadQuality();
    this.lighting = new Lighting(gpu, scene);
    this.sun = this.lighting.sun;
    const u = this.lighting.u;
    this.haze = { color: u.hazeColor, sunColor: u.hazeSunColor, density: u.hazeDensity, heightFalloff: u.hazeHeightFalloff };
    this.apply();
  }

  /** Rebuild the IBL map (debug: after tweaking `lighting.u.envGround`). */
  buildEnvironment() { this.lighting.buildEnvironment(); }

  /** Blend clear (0) to storm (1); see world/lighting.ts. */
  setWeather(t: number) { this.lighting.setWeather(t); }

  /**
   * Ambient occlusion for the roofed bunkers: the environment map has no idea a point is under a concrete slab, so
   * without this the interior glows with full sky light. Fades in across the wall thickness to 30 % ambient.
   */
  private buildInteriorAO(): THREE.Node<'float'> {
    const half = MAP.bunker.interior / 2, roof = MAP.bunker.height + 0.05;
    let inside: THREE.Node<'float'> = float(0);
    for (const u of this.interiors) {
      const d = positionWorld.sub(u.xyz);
      const c = cos(u.w), s = sin(u.w);
      const lx = d.x.mul(c).sub(d.z.mul(s)).abs(), lz = d.x.mul(s).add(d.z.mul(c)).abs();
      const edge = min(float(half).sub(lx), float(half).sub(lz));
      const k = smoothstep(-0.2, 0.35, edge).mul(step(d.y, roof)).mul(step(-0.5, d.y));
      inside = max(inside, k);
    }
    return mix(float(1), float(0.3), inside);
  }

  setInteriors(map: IslandLayout[]) {
    if (map.length > this.interiors.length) console.warn(`[world/sky] ${map.length} bunkers, interior AO covers only ${this.interiors.length}`);
    map.slice(0, this.interiors.length).forEach((isl, i) => this.interiors[i].value.set(isl.bunker.center.x, isl.groundY, isl.bunker.center.z, isl.bunker.facingYaw));
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    saveQuality(q);
    this.apply();
    console.info(`[world/sky] quality → ${q}`);
  }

  setResolutionScale(s: number) {
    if (s === this.resScale) return;
    this.resScale = s;
    this.applyPixelRatio();
  }

  /** Dynamic resolution (dynRes.ts): a further multiplier, changed by the frame loop to hold the frame rate. */
  setDynamicScale(s: number) {
    if (s === this.dynScale) return;
    this.dynScale = s;
    this.applyPixelRatio();
  }
  private dynScale = 1;

  private applyPixelRatio() {
    const base = Math.min(window.devicePixelRatio, PRESETS[this.quality].pixelRatio);
    this.gpu.setPixelRatio(Math.min(2, Math.max(0.5, base * this.resScale * this.dynScale)));
  }

  /** Effective pixel ratio the scene renders at (debug/perf). */
  get pixelRatio() { return this.gpu.getPixelRatio(); }

  toggleQuality(): Quality {
    this.setQuality(QUALITIES[(QUALITIES.indexOf(this.quality) + 1) % QUALITIES.length]);
    return this.quality;
  }

  private apply() {
    const p = PRESETS[this.quality];
    this.applyPixelRatio();

    if (this.lighting.applyShadows(p.shadow)) {
      // the shadow node is baked into every lit material's shader: rebuild them
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
      });
    }

    this.pipeline?.dispose();
    this.pipeline = buildPipeline(this.gpu, this.scene, this.camera, p.post, this.interiorAO);
  }

  /** Draw the frame (cascades follow the camera on their own). */
  render() {
    if (PRESETS[this.quality].post.flare) {
      const v = this.sunTmp.copy(LIGHT_SUN_DIR).multiplyScalar(1000).add(this.camera.position).project(this.camera);
      sunScreen.uv.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
      sunScreen.front.value = v.z < 1 ? 1 : 0;
      sunScreen.aspect.value = this.camera.aspect;
    }
    this.pipeline!.render();
  }

  dispose() { this.pipeline?.dispose(); this.lighting.dispose(); }
}

/** 'P' cycles the preset low → high → ultra (ignored while typing in an input). */
export function installQualityToggle(sky: SkyLighting) {
  let toast: HTMLDivElement | null = null;
  let hideAt = 0;
  window.addEventListener('keydown', (e) => {
    if (!isAction('quality', e.code) || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const q = sky.toggleQuality();
    if (!toast) {
      toast = document.createElement('div');
      toast.dataset.testid = 'quality-toast';
      toast.style.cssText = 'position:fixed;left:50%;top:84px;transform:translateX(-50%);padding:6px 14px;border-radius:8px;'
        + 'background:rgba(15,20,26,.72);color:#fff;font:600 13px "Helvetica Neue",Arial,sans-serif;letter-spacing:.06em;z-index:50;pointer-events:none';
      document.body.append(toast);
    }
    toast.textContent = `GRAPHICS: ${q.toUpperCase()}  (${bindingLabel(activeKeymap(), 'quality')})`;
    toast.style.display = 'block';
    hideAt = performance.now() + 1500;
    setTimeout(() => { if (toast && performance.now() >= hideAt) toast.style.display = 'none'; }, 1600);
  });
}

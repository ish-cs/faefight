import * as THREE from 'three/webgpu';
import { cos, float, max, min, mix, positionWorld, sin, smoothstep, step, uniform } from 'three/tsl';
import { MAP } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import { activeKeymap, bindingLabel, isAction } from '../keymap';
import { settings } from '../settings/store';
import { Lighting, type ShadowPreset, SUN_DIR as LIGHT_SUN_DIR } from './lighting';
import { SMALL_CASTER_LAYER } from './lod';
import { cascadeToRefresh, type CascadeCacheState, newCacheState, SHADOW_CACHE } from './shadowCache';
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
/** Competitive mode's post chain overrides (see setCompetitive). */
const COMPETITIVE_POST: Partial<PostOptions> = { samples: 2, bloom: false, ao: false, flare: false };

// low: 2 small cascades over a short range; high: 3 cascades (crisp near, shorter reach than ultra);
// ultra: 4 cascades with a long reach. GTAO + bloom on high/ultra (AO at half resolution).
const PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 1, shadow: { cascades: 2, mapSize: 1024, far: 90 }, post: { samples: 4, bloom: false, ao: false } },
  high: { pixelRatio: 1.25, shadow: { cascades: 3, mapSize: 2048, far: 180 }, post: { samples: 4, bloom: true, ao: { resolution: 0.5, samples: 8 }, flare: true } },
  ultra: { pixelRatio: 2, shadow: { cascades: 4, mapSize: 2048, far: 300 }, post: { samples: 4, bloom: true, ao: { resolution: 0.5, samples: 16 }, flare: true } },
};

/** Far-cascade caster mask: layer 0 only (+ unused bit 31, see cascadeLayers). */
const FAR_CASCADE_MASK = 1 | (1 << 31);

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
  /** Main lit-scene pass of the post chain (render target + MRT + context every world material compiles for). */
  scenePass: THREE.PassNode | null = null;
  private sunTmp = new THREE.Vector3();

  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera) {
    this.quality = loadQuality();
    camera.layers.enable(SMALL_CASTER_LAYER); // small props: drawn by the camera, cast into the near cascades only
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

  /**
   * Competitive mode (Settings → Video): readable but fast on top of any preset: 1× render scale, no GTAO, bloom
   * or lens flare, MSAA ×2. Changing it rebuilds the post chain (settings change, never mid-frame-loop governance).
   */
  private competitive = settings.get().video.competitive;
  setCompetitive(on: boolean) {
    if (on === this.competitive) return;
    this.competitive = on;
    this.apply();
  }

  private applyPixelRatio() {
    const base = Math.min(window.devicePixelRatio, this.competitive ? 1 : PRESETS[this.quality].pixelRatio);
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

    this.shadowCache = null; // new or resized cascades: render them all fresh
    if (this.lighting.applyShadows({ ...p.shadow, mapSize: Math.round(p.shadow.mapSize * this.govShadow) })) {
      // the shadow node is baked into every lit material's shader: rebuild them
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
      });
    }

    this.pipeline?.dispose();
    const post = this.competitive ? { ...PRESETS[this.quality].post, ...COMPETITIVE_POST } : PRESETS[this.quality].post;
    const built = buildPipeline(this.gpu, this.scene, this.camera, { ...post, ...this.postOverride }, this.interiorAO);
    this.pipeline = built.pipe;
    this.scenePass = built.scenePass;
    this.aoPass = built.aoPass;
    this.applyAoBudget();
  }
  private aoPass: { resolutionScale: number } | null = null;
  /** Debug/profiling only (GPU cost bisect): post options over the preset's; rebuilds the chain (a full recompile). */
  private postOverride: Partial<PostOptions> = {};
  debugPost(o: Partial<PostOptions>) { this.postOverride = o; this.apply(); }
  /** GTAO budget: the governor's cheap mode renders AO at 60 % of the preset's resolution (live, no recompile). */
  private applyAoBudget() {
    const ao = this.competitive ? false : PRESETS[this.quality].post.ao;
    if (this.aoPass && ao) this.aoPass.resolutionScale = ao.resolution * (this.govAo ? 1 : 0.6);
  }

  private govAo = true;
  private govShadow = 1;

  /**
   * Frame-time governor knobs (governor.ts): GTAO full / cheap (resolution, live) and a shadow-map size multiplier
   * (applied live to every cascade). Neither recompiles a shader.
   */
  setGovernor(k: { ao: boolean; shadowScale: number }) {
    // never rebuild the post chain here (a mid-match shader compile is a 100+ ms hitch): AO only gets cheaper
    if (k.ao !== this.govAo) { this.govAo = k.ao; this.applyAoBudget(); }
    if (k.shadowScale !== this.govShadow) {
      this.govShadow = k.shadowScale;
      const size = Math.round(PRESETS[this.quality].shadow.mapSize * k.shadowScale);
      this.sun.shadow.mapSize.set(size, size);
      for (const l of this.lighting.csm?.lights ?? []) l.shadow!.mapSize.set(size, size);
      this.shadowCache = null; // cached far maps are the old size: redraw them
    }
  }

  /** Whether the current preset has screen-space AO at all (the governor skips the AO rung when not). */
  get presetHasAo(): boolean { return !!PRESETS[this.quality].post.ao; }

  /** Draw the frame (cascades follow the camera on their own). */
  render() {
    if (PRESETS[this.quality].post.flare) {
      const v = this.sunTmp.copy(LIGHT_SUN_DIR).multiplyScalar(1000).add(this.camera.position).project(this.camera);
      sunScreen.uv.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
      sunScreen.front.value = v.z < 1 ? 1 : 0;
      sunScreen.aspect.value = this.camera.aspect;
    }
    this.cascadeLayers();
    this.pipeline!.render();
  }

  /**
   * Shadow-caster culling per cascade: the near cascades see every caster (camera's layers); the far ones skip the
   * SMALL_CASTER_LAYER (an extra unused layer bit keeps ShadowNode from copying the camera's mask over it).
   */
  private cascadeLayers() {
    const lights = this.lighting.csm?.lights;
    if (!lights?.length) return;
    const near = lights.length >= 3 ? 2 : 1;
    for (let i = 0; i < lights.length; i++) lights[i].shadow!.camera.layers.mask = i < near ? this.camera.layers.mask : FAR_CASCADE_MASK;
    this.cacheFarCascades(lights, near);
  }

  /** Far cascades re-render only when the camera moved/turned enough or they got old (shadowCache.ts). */
  shadowCacheEnabled = true;
  private shadowCache: CascadeCacheState | null = null;
  private cacheAnchor = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), tmp: new THREE.Vector3() };
  /** far-cascade renders skipped / done (debug) */
  readonly shadowCacheStats = { skipped: 0, rendered: 0 };
  private cacheFarCascades(lights: { shadow?: THREE.LightShadow | null }[], near: number) {
    if (!this.shadowCacheEnabled) { for (const l of lights) l.shadow!.autoUpdate = true; return; }
    if (!this.shadowCache || this.shadowCache.age.length !== lights.length) {
      // new / resized cascades: their maps hold nothing yet, so draw every one now (never sample an empty map)
      this.shadowCache = newCacheState(lights.length);
      for (const l of lights) { l.shadow!.autoUpdate = true; }
      for (let i = near; i < lights.length; i++) this.shadowCache.age[i] = 0, this.shadowCache.dirty[i] = false;
      this.cacheAnchor.pos.copy(this.camera.position);
      this.camera.getWorldDirection(this.cacheAnchor.dir);
      return;
    }
    const a = this.cacheAnchor, cam = this.camera;
    cam.getWorldDirection(a.tmp);
    const moved = cam.position.distanceTo(a.pos) > SHADOW_CACHE.moveM || a.tmp.angleTo(a.dir) > SHADOW_CACHE.turnRad;
    if (moved) { a.pos.copy(cam.position); a.dir.copy(a.tmp); }
    const pick = cascadeToRefresh(this.shadowCache, near, moved);
    for (let i = 0; i < lights.length; i++) {
      const sh = lights[i].shadow!;
      if (i < near) { sh.autoUpdate = true; continue; }
      sh.autoUpdate = false;
      if (i === pick) { sh.needsUpdate = true; this.shadowCacheStats.rendered++; } else this.shadowCacheStats.skipped++;
    }
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

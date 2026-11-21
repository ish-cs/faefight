import * as THREE from 'three/webgpu';
import { cameraPosition, color, cos, dot, exp, float, fog, luminance, max, min, mix, normalize, positionView, positionWorld, pow, sin, smoothstep, step, uniform, vec3, vec4 } from 'three/tsl';
import { MAP } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { activeKeymap, bindingLabel, isAction } from '../keymap';
import { settings } from '../settings/store';
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

/** Late-morning sun ≈ 38° elevation. Sky dome, environment map, key light, haze and water glints all derive from this. */
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(58));

type Preset = {
  pixelRatio: number;
  /** cascaded shadow maps: count × size², shadow distance (m) */
  cascades: number; shadowMap: number; shadowFar: number;
  post: PostOptions;
};
/** Competitive mode's post chain overrides (see setCompetitive). */
const COMPETITIVE_POST: Partial<PostOptions> = { samples: 2, bloom: false, ao: false, flare: false };

const PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 1, cascades: 2, shadowMap: 1024, shadowFar: 110, post: { samples: 4, bloom: false, ao: false } },
  high: { pixelRatio: 1.25, cascades: 3, shadowMap: 2048, shadowFar: 220, post: { samples: 4, bloom: true, ao: { resolution: 0.5, samples: 8 }, flare: true } },
  ultra: { pixelRatio: 2, cascades: 4, shadowMap: 2048, shadowFar: 320, post: { samples: 4, bloom: true, ao: { resolution: 0.5, samples: 12 }, flare: true } },
};

/** Far-cascade caster mask: layer 0 only (+ unused bit 31, see cascadeLayers). */
const FAR_CASCADE_MASK = 1 | (1 << 31);

const SKY = { turbidity: 3, rayleigh: 1.5, mieCoefficient: 0.002, mieDirectionalG: 0.9 };

function makeSky(clouds: boolean) {
  const sky = new SkyMesh();
  sky.scale.setScalar(4000);
  sky.turbidity.value = SKY.turbidity;
  sky.rayleigh.value = SKY.rayleigh;
  sky.mieCoefficient.value = SKY.mieCoefficient;
  sky.mieDirectionalG.value = SKY.mieDirectionalG;
  sky.sunPosition.value.copy(SUN_DIR);
  sky.cloudCoverage.value = clouds ? 0.35 : 0.2;
  sky.cloudDensity.value = clouds ? 0.5 : 0.35;
  return sky;
}

/** Re-grade a SkyMesh's output: gain + saturation around luminance. */
function regradeSky(sky: SkyMesh, gain: THREE.Node<'float'> | number, saturation: THREE.Node<'float'> | number) {
  const mat = sky.material as THREE.NodeMaterial;
  const rgb = (mat.colorNode as THREE.Node<'vec4'>).rgb.mul(gain);
  mat.colorNode = vec4(mix(vec3(luminance(rgb)), rgb, saturation), 1);
}

/**
 * Sky dome, image-based lighting, warm cascaded-shadow sun, aerial-perspective haze, ACES tone mapping, colour
 * grade, and (high/ultra) GTAO + bloom. Owns the frame's final draw so the post chain follows the quality preset.
 */
export class SkyLighting {
  readonly sun = new THREE.DirectionalLight(0xffe9cc, 6);
  /** live-tweakable grade uniforms (debug) */
  readonly grade = grade;
  /** haze uniforms (debug) */
  readonly haze = {
    color: uniform(new THREE.Color(0x9fc0dc)),
    sunColor: uniform(new THREE.Color(0xf4dcb4)),
    density: uniform(0.0011),
    heightFalloff: uniform(0.012),
  };
  /** brightness of the bounce hemisphere baked into the environment map (debug: tweak, then buildEnvironment()) */
  readonly envGround = uniform(12);
  /** main sky dome brightness / saturation (the env map uses its own hazier copy) */
  readonly skyGain = uniform(0.7);
  readonly skySaturation = uniform(1.12);
  /** bunker interiors (x, groundY, z, yaw) — up to 8; parked far away until setMap */
  private interiors = Array.from({ length: 8 }, () => uniform(new THREE.Vector4(1e6, 0, 1e6, 0)));
  private interiorAO = this.buildInteriorAO();
  quality: Quality;
  /** Settings → Video resolution scale: multiplies the preset's pixel ratio (result clamped to 0.5–2). */
  private resScale = settings.get().video.resolutionScale;
  private pipeline: THREE.RenderPipeline | null = null;
  /** Main lit-scene pass of the post chain (render target + MRT + context every world material compiles for). */
  scenePass: THREE.PassNode | null = null;
  private csm: CSMShadowNode | null = null;
  private sunTmp = new THREE.Vector3();

  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene, readonly camera: THREE.PerspectiveCamera) {
    this.quality = loadQuality();
    camera.layers.enable(SMALL_CASTER_LAYER); // small props: drawn by the camera, cast into the near cascades only
    gpu.toneMapping = THREE.ACESFilmicToneMapping;
    gpu.toneMappingExposure = 0.5;
    gpu.shadowMap.enabled = true;
    gpu.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is removed in WebGPURenderer; soften via radius

    const sky = makeSky(true);
    regradeSky(sky, this.skyGain, this.skySaturation);
    scene.add(sky);
    this.buildEnvironment();

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 700;
    this.sun.position.copy(SUN_DIR).multiplyScalar(200);
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun, this.sun.target);

    // Aerial perspective: exponential distance haze that thins with altitude, warmer when looking toward the sun.
    const h = this.haze;
    const viewDir = normalize(positionWorld.sub(cameraPosition));
    const toSun = pow(max(dot(viewDir, uniform(SUN_DIR.clone())), 0), 6);
    const dist = positionView.z.negate();
    const heightK = exp(max(positionWorld.y, 0).mul(h.heightFalloff).negate());
    const amount = float(1).sub(exp(dist.mul(h.density).mul(heightK).negate()));
    scene.fogNode = fog(mix(h.color, h.sunColor, toSun.mul(0.6)), amount);

    this.apply();
  }

  /**
   * IBL: PMREM of the same sky (sun disc removed — the DirectionalLight is the sun) above a lower hemisphere that
   * stands in for light bounced off the sea and sun-baked concrete. Gives every PBR material matching ambient +
   * reflections (containers, galvanised steel, water). The ambient sky is hazier and half-desaturated: a pure
   * Rayleigh dome turns every shaded face violet-blue.
   */
  buildEnvironment() {
    try {
      (this.scene.environment as THREE.Texture | null)?.dispose();
      const envScene = new THREE.Scene();
      const sky = makeSky(false);
      sky.showSunDisc.value = 0;
      sky.turbidity.value = 9;
      sky.rayleigh.value = 0.9;
      regradeSky(sky, 1, 0.5);
      envScene.add(sky);
      const groundMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
      // warm sunlit-quay bounce near the horizon, teal-grey sea straight down
      const y = normalize(positionWorld).y.negate().clamp(0, 1);
      groundMat.colorNode = mix(color(0.34, 0.33, 0.28), color(0.1, 0.17, 0.19), y.pow(0.5)).mul(this.envGround);
      groundMat.fog = false;
      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2), groundMat));
      const pmrem = new THREE.PMREMGenerator(this.gpu);
      this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
      this.scene.environmentIntensity = 0.8;
      pmrem.dispose();
    } catch (err) {
      console.warn('[world/sky] sky environment map unavailable, using hemisphere light only', err);
      this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x8a7a58, 0.8));
    }
  }

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

    // Cascaded shadows: crisp near the player, still casting long shadows out to `shadowFar`. CSMShadowNode
    // snaps each cascade to its texel grid, so edges don't shimmer as the camera moves.
    const sh = this.sun.shadow;
    const size = p.shadowMap * this.govShadow;
    sh.mapSize.set(size, size);
    sh.radius = p.shadowMap >= 2048 ? 2.5 : 1.5;
    const prev = this.csm;
    const csm = new CSMShadowNode(this.sun, { cascades: p.cascades, maxFar: p.shadowFar, mode: 'practical', lightMargin: 120 });
    csm.fade = true;
    sh.shadowNode = csm;
    this.csm = csm;
    this.shadowCache = null; // new cascades: render them all fresh
    if (prev) {
      prev.dispose();
      // the shadow node is baked into every lit material's shader → rebuild them
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
      const size = PRESETS[this.quality].shadowMap * k.shadowScale;
      this.sun.shadow.mapSize.set(size, size);
      for (const l of this.csm?.lights ?? []) l.shadow!.mapSize.set(size, size);
      this.shadowCache = null; // cached far maps are the old size: redraw them
    }
  }

  /** Whether the current preset has screen-space AO at all (the governor skips the AO rung when not). */
  get presetHasAo(): boolean { return !!PRESETS[this.quality].post.ao; }

  /** Draw the frame (cascades follow the camera on their own). */
  render() {
    if (PRESETS[this.quality].post.flare) {
      const v = this.sunTmp.copy(SUN_DIR).multiplyScalar(1000).add(this.camera.position).project(this.camera);
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
    const lights = this.csm?.lights;
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

  dispose() { this.pipeline?.dispose(); this.csm?.dispose(); }
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

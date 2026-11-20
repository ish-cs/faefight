import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, exp, float, fog, luminance, max, mix, normalize, positionView, positionWorld, pow, uniform, vec3, vec4 } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { buildPipeline, grade, type PostOptions } from './post';

export type Quality = 'low' | 'high' | 'ultra';
const QUALITIES: Quality[] = ['low', 'high', 'ultra'];
const QUALITY_KEY = 'faefight.quality';

export function loadQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY) as Quality | null;
    if (q && QUALITIES.includes(q)) return q;
  } catch { /* storage blocked: fall through to default */ }
  return 'high';
}
function saveQuality(q: Quality) {
  try { localStorage.setItem(QUALITY_KEY, q); } catch (err) { console.warn('[world/sky] could not persist quality preset', err); }
}

/** Late-morning sun ≈ 38° elevation. Sky dome, environment map, key light, haze and water glints all derive from this. */
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(58));

type Preset = {
  pixelRatio: number;
  /** cascaded shadow maps: count × size², shadow distance (m) */
  cascades: number; shadowMap: number; shadowFar: number;
  post: PostOptions;
};
const PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 1, cascades: 2, shadowMap: 1024, shadowFar: 110, post: { samples: 4, bloom: false, ao: false } },
  high: { pixelRatio: 1.5, cascades: 3, shadowMap: 2048, shadowFar: 220, post: { samples: 4, bloom: true, ao: { resolution: 0.5, samples: 12 } } },
  ultra: { pixelRatio: 2, cascades: 4, shadowMap: 2048, shadowFar: 320, post: { samples: 4, bloom: true, ao: { resolution: 0.75, samples: 16 } } },
};

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
  quality: Quality;
  private pipeline: THREE.RenderPipeline | null = null;
  private csm: CSMShadowNode | null = null;

  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    this.quality = loadQuality();
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

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    saveQuality(q);
    this.apply();
    console.info(`[world/sky] quality → ${q}`);
  }

  toggleQuality(): Quality {
    this.setQuality(QUALITIES[(QUALITIES.indexOf(this.quality) + 1) % QUALITIES.length]);
    return this.quality;
  }

  private apply() {
    const p = PRESETS[this.quality];
    this.gpu.setPixelRatio(Math.min(window.devicePixelRatio, p.pixelRatio));

    // Cascaded shadows: crisp near the player, still casting long shadows out to `shadowFar`. CSMShadowNode
    // snaps each cascade to its texel grid, so edges don't shimmer as the camera moves.
    const sh = this.sun.shadow;
    sh.mapSize.set(p.shadowMap, p.shadowMap);
    sh.radius = p.shadowMap >= 2048 ? 2.5 : 1.5;
    const prev = this.csm;
    const csm = new CSMShadowNode(this.sun, { cascades: p.cascades, maxFar: p.shadowFar, mode: 'practical', lightMargin: 120 });
    csm.fade = true;
    sh.shadowNode = csm;
    this.csm = csm;
    if (prev) {
      prev.dispose();
      // the shadow node is baked into every lit material's shader → rebuild them
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
      });
    }

    this.pipeline?.dispose();
    this.pipeline = buildPipeline(this.gpu, this.scene, this.camera, p.post);
  }

  /** Draw the frame (cascades follow the camera on their own). */
  render() {
    this.pipeline!.render();
  }

  dispose() { this.pipeline?.dispose(); this.csm?.dispose(); }
}

/** 'P' cycles the preset low → high → ultra (ignored while typing in an input). */
export function installQualityToggle(sky: SkyLighting) {
  let toast: HTMLDivElement | null = null;
  let hideAt = 0;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyP' || e.repeat) return;
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
    toast.textContent = `GRAPHICS: ${q.toUpperCase()}  (P)`;
    toast.style.display = 'block';
    hideAt = performance.now() + 1500;
    setTimeout(() => { if (toast && performance.now() >= hideAt) toast.style.display = 'none'; }, 1600);
  });
}

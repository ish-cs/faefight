import * as THREE from 'three/webgpu';
import { emissive, mrt, output, pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { activeKeymap, bindingLabel, isAction } from '../keymap';
import { settings } from '../settings/store';

export type Quality = 'low' | 'high';

/** Persisted in Settings → Video. */
export function loadQuality(): Quality {
  return settings.get().video.quality;
}
function saveQuality(q: Quality) {
  settings.update((s) => { s.video.quality = q; });
}

/** Sun ≈ 34° elevation, warm. */
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 36), THREE.MathUtils.degToRad(58));

const PRESETS: Record<Quality, { pixelRatio: number; shadowMap: number; shadowExtent: number; bloom: boolean; samples: number }> = {
  low: { pixelRatio: 1, shadowMap: 2048, shadowExtent: 38, bloom: false, samples: 0 },
  high: { pixelRatio: 1.5, shadowMap: 4096, shadowExtent: 55, bloom: true, samples: 4 },
};

/**
 * Sky dome, image-based ambient, warm sun with soft shadows, haze, tone mapping and (high) bloom.
 * Owns the frame's final draw so the post chain can be switched by the quality preset.
 */
export class SkyLighting {
  readonly sun = new THREE.DirectionalLight(0xffe6c2, 4.2);
  quality: Quality;
  /** Settings → Video resolution scale: multiplies the preset's pixel ratio (result clamped to 0.5–2). */
  private resScale = settings.get().video.resolutionScale;
  private pipeline: THREE.RenderPipeline | null = null;

  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene, private camera: THREE.Camera) {
    this.quality = loadQuality();
    gpu.toneMapping = THREE.ACESFilmicToneMapping;
    gpu.toneMappingExposure = 0.5;
    gpu.shadowMap.enabled = true;

    const sky = new SkyMesh();
    sky.scale.setScalar(4000);
    sky.turbidity.value = 5;
    sky.rayleigh.value = 1.5;
    sky.mieCoefficient.value = 0.004;
    sky.mieDirectionalG.value = 0.85;
    sky.cloudCoverage.value = 0.35;
    sky.cloudDensity.value = 0.5;
    sky.sunPosition.value.copy(SUN_DIR);
    scene.add(sky);

    try {
      const envScene = new THREE.Scene();
      const envSky = new SkyMesh();
      envSky.scale.setScalar(4000);
      envSky.turbidity.value = 5; envSky.rayleigh.value = 1.5;
      envSky.sunPosition.value.copy(SUN_DIR);
      envSky.showSunDisc.value = 0;
      envSky.cloudCoverage.value = 0;
      envScene.add(envSky);
      const pmrem = new THREE.PMREMGenerator(gpu);
      scene.environment = pmrem.fromScene(envScene).texture;
      scene.environmentIntensity = 0.38;
    } catch (err) {
      console.warn('[world/sky] sky environment map unavailable, using hemisphere light only', err);
    }
    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x8a7a58, 0.32));

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    scene.fog = new THREE.FogExp2(0xb4d0e2, 0.0019);
    this.apply();
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

  private applyPixelRatio() {
    const base = Math.min(window.devicePixelRatio, PRESETS[this.quality].pixelRatio);
    this.gpu.setPixelRatio(Math.min(2, Math.max(0.5, base * this.resScale)));
  }

  toggleQuality(): Quality {
    this.setQuality(this.quality === 'high' ? 'low' : 'high');
    return this.quality;
  }

  private apply() {
    const p = PRESETS[this.quality];
    this.applyPixelRatio();
    this.gpu.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is removed in WebGPURenderer; soften via radius
    this.sun.shadow.radius = p.shadowMap > 2048 ? 3 : 1;
    const sh = this.sun.shadow;
    if (sh.mapSize.x !== p.shadowMap) {
      sh.mapSize.set(p.shadowMap, p.shadowMap);
      sh.map?.dispose();
      sh.map = null;
    }
    const sc = sh.camera;
    sc.left = -p.shadowExtent; sc.right = p.shadowExtent; sc.top = p.shadowExtent; sc.bottom = -p.shadowExtent;
    sc.near = 1; sc.far = 260;
    sc.updateProjectionMatrix();
    this.pipeline?.dispose();
    this.pipeline = null;
    if (p.bloom) {
      const pipe = new THREE.RenderPipeline(this.gpu);
      // Bloom only what is emissive (generator glow etc.), never the bright sky/sea.
      const scenePass = pass(this.scene, this.camera, { samples: p.samples });
      scenePass.setMRT(mrt({ output, emissive }));
      const col = scenePass.getTextureNode('output');
      const glow = scenePass.getTextureNode('emissive');
      pipe.outputNode = col.add(bloom(glow, 0.9, 0.5, 0));
      this.pipeline = pipe;
    }
  }

  /** Keep the shadow frustum centred on what the camera sees, then draw the frame. */
  render(focus: THREE.Vector3) {
    // snap to shadow texels to avoid shimmering edges while moving
    const ext = PRESETS[this.quality].shadowExtent, texel = (2 * ext) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 120);
    if (this.pipeline) this.pipeline.render();
    else this.gpu.render(this.scene, this.camera);
  }

  dispose() { this.pipeline?.dispose(); }
}

/** 'P' toggles the preset (ignored while typing in an input). */
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

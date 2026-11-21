import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, exp, float, fog, luminance, max, mix, normalize, positionView, positionWorld, pow, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

/**
 * The scene's lighting rig in one place: sky dome, image-based lighting (PMREM of the sky above a sand/sea bounce
 * hemisphere), warm key sun with cascaded shadows, a hemisphere fill tinted by sand and water, aerial-perspective
 * haze and the tone-mapping exposure. Everything weather-dependent is a uniform or light property that
 * `setWeather(t)` blends between a clear late morning (t = 0) and a dark rain squall (t = 1), so a storm can dim the
 * whole scene without rebuilding shaders or the environment map.
 *
 * For other systems (storm, water, viewmodel):
 *   - `SUN_DIR` direction toward the sun (fixed; shadows and the sky are built around it)
 *   - `lighting.current` the live rig (null before the renderer starts): `.sun`, `.hemi`, `.u` (uniforms), `.weather`
 *   - `setWeather(t)` module-level shortcut; safe to call before the rig exists (applied when it's created)
 *   - `glint` uniform: sun-glint strength on water/wet surfaces (1 clear → ~0 under storm cloud)
 */

/** Late-morning sun ≈ 38° elevation. Sky dome, environment map, key light, haze and water glints all derive from this. */
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(58));

/** Sun-glint strength for water / wet materials (0..1); follows the weather. */
export const glint = uniform(1);

type WeatherKey = {
  sun: number; sunColor: THREE.Color;
  hemi: number; hemiSky: THREE.Color; hemiGround: THREE.Color;
  env: number; exposure: number;
  skyGain: number; skySat: number; turbidity: number; rayleigh: number; clouds: number; cloudDensity: number;
  haze: THREE.Color; hazeSun: THREE.Color; hazeDensity: number;
};
const CLEAR: WeatherKey = {
  sun: 7.8, sunColor: new THREE.Color(0xffdfb4),
  // sky-blue from above, warm sand + teal sea bounce from below
  hemi: 0.2, hemiSky: new THREE.Color(0xbcd6f0), hemiGround: new THREE.Color(0xb8a27a).lerp(new THREE.Color(0x4f7f86), 0.35),
  env: 0.68, exposure: 0.52,
  skyGain: 0.7, skySat: 1.12, turbidity: 3, rayleigh: 1.5, clouds: 0.35, cloudDensity: 0.5,
  haze: new THREE.Color(0xa6c3dc), hazeSun: new THREE.Color(0xf6dcb0), hazeDensity: 0.0012,
};
const STORM: WeatherKey = {
  sun: 0.5, sunColor: new THREE.Color(0xa8b4c4),
  hemi: 0.75, hemiSky: new THREE.Color(0x7c8a9a), hemiGround: new THREE.Color(0x3c4a50),
  env: 0.3, exposure: 0.62,
  skyGain: 0.24, skySat: 0.12, turbidity: 10, rayleigh: 0.4, clouds: 1, cloudDensity: 1,
  haze: new THREE.Color(0x5f6a74), hazeSun: new THREE.Color(0x707a84), hazeDensity: 0.0065,
};

const SKY = { turbidity: CLEAR.turbidity, rayleigh: CLEAR.rayleigh, mieCoefficient: 0.002, mieDirectionalG: 0.9 };

function makeSky(clouds: boolean) {
  const sky = new SkyMesh();
  sky.scale.setScalar(4000);
  sky.turbidity.value = SKY.turbidity;
  sky.rayleigh.value = SKY.rayleigh;
  sky.mieCoefficient.value = SKY.mieCoefficient;
  sky.mieDirectionalG.value = SKY.mieDirectionalG;
  sky.sunPosition.value.copy(SUN_DIR);
  sky.cloudCoverage.value = clouds ? CLEAR.clouds : 0.2;
  sky.cloudDensity.value = clouds ? CLEAR.cloudDensity : 0.35;
  return sky;
}

/** Re-grade a SkyMesh's output: gain + saturation around luminance. */
function regradeSky(sky: SkyMesh, gain: THREE.Node<'float'> | number, saturation: THREE.Node<'float'> | number) {
  const mat = sky.material as THREE.NodeMaterial;
  const rgb = (mat.colorNode as THREE.Node<'vec4'>).rgb.mul(gain);
  mat.colorNode = vec4(mix(vec3(luminance(rgb)), rgb, saturation), 1);
}

/** Cascaded-shadow settings for one quality preset. */
export type ShadowPreset = { cascades: number; mapSize: number; far: number };

export class Lighting {
  readonly sun = new THREE.DirectionalLight(CLEAR.sunColor, CLEAR.sun);
  /** sand/sea-tinted bounce + sky fill (weather-scaled; the env map carries the detailed ambient) */
  readonly hemi = new THREE.HemisphereLight(CLEAR.hemiSky, CLEAR.hemiGround, CLEAR.hemi);
  readonly sky = makeSky(true);
  /** live uniforms (debug-tweakable; setWeather drives them) */
  readonly u = {
    skyGain: uniform(CLEAR.skyGain),
    skySaturation: uniform(CLEAR.skySat),
    hazeColor: uniform(CLEAR.haze.clone()),
    hazeSunColor: uniform(CLEAR.hazeSun.clone()),
    hazeDensity: uniform(CLEAR.hazeDensity),
    hazeHeightFalloff: uniform(0.012),
    /** brightness of the bounce hemisphere baked into the environment map (tweak, then buildEnvironment()) */
    envGround: uniform(12),
    glint,
  };
  /** current weather 0 (clear) .. 1 (storm) */
  weather = 0;
  private csm: CSMShadowNode | null = null;

  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene) {
    gpu.toneMapping = THREE.ACESFilmicToneMapping; // the display grade (post.ts) is tuned around ACES' shoulder
    gpu.toneMappingExposure = CLEAR.exposure;
    gpu.shadowMap.enabled = true;
    gpu.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is removed in WebGPURenderer; soften via radius

    regradeSky(this.sky, this.u.skyGain, this.u.skySaturation);
    scene.add(this.sky);
    this.buildEnvironment();

    const s = this.sun;
    s.name = 'sun';
    s.castShadow = true;
    s.position.copy(SUN_DIR).multiplyScalar(200);
    s.target.position.set(0, 0, 0);
    s.shadow.camera.near = 1;
    s.shadow.camera.far = 700;
    this.hemi.name = 'hemiBounce';
    this.hemi.position.set(0, 1, 0);
    scene.add(s, s.target, this.hemi);

    // Aerial perspective: exponential distance haze that thins with altitude (so the far sea and hills soften toward
    // the horizon while nearby props stay crisp), warmer when looking toward the sun.
    const u = this.u;
    const viewDir = normalize(positionWorld.sub(cameraPosition));
    const toSun = pow(max(dot(viewDir, uniform(SUN_DIR.clone())), 0), 6);
    const dist = positionView.z.negate();
    const heightK = exp(max(positionWorld.y, 0).mul(u.hazeHeightFalloff).negate());
    // a little extra density past ~250 m: the horizon line melts into the sky instead of a hard sea edge
    const far = smoothstep(250, 900, dist).mul(0.25);
    const amount = float(1).sub(exp(dist.mul(u.hazeDensity).mul(heightK).negate())).add(far).clamp(0, 1);
    scene.fogNode = fog(mix(u.hazeColor, u.hazeSunColor, toSun.mul(0.6)), amount);

    lighting.current = this;
    if (pendingWeather !== null) this.setWeather(pendingWeather);
  }

  /**
   * IBL: PMREM of the same sky (sun disc removed — the DirectionalLight is the sun) above a lower hemisphere that
   * stands in for light bounced off the sea and sun-baked concrete. Gives every PBR material matching ambient +
   * reflections (containers, galvanised steel, wet ground, water). The ambient sky is hazier and half-desaturated:
   * a pure Rayleigh dome turns every shaded face violet-blue.
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
      groundMat.colorNode = mix(color(0.36, 0.33, 0.27), color(0.1, 0.17, 0.19), y.pow(0.5)).mul(this.u.envGround);
      groundMat.fog = false;
      envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2), groundMat));
      const pmrem = new THREE.PMREMGenerator(this.gpu);
      this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
      this.scene.environmentIntensity = this.envIntensity();
      pmrem.dispose();
    } catch (err) {
      console.warn('[world/lighting] sky environment map unavailable, leaning on the hemisphere light', err);
      this.hemi.intensity = 1.2;
    }
  }

  private envIntensity() { return THREE.MathUtils.lerp(CLEAR.env, STORM.env, this.weather); }

  /**
   * Cascaded shadows: crisp near the player, still casting long shadows out to `far`. CSMShadowNode snaps each
   * cascade to its texel grid (no shimmer). Bias is scaled to the texel size of the nearest cascade: no acne on the
   * slab, no peter-panning under crates. Returns true when lit materials must recompile (the shadow node changed).
   */
  applyShadows(p: ShadowPreset): boolean {
    const sh = this.sun.shadow;
    sh.mapSize.set(p.mapSize, p.mapSize);
    // wider PCF kernel at higher resolution keeps the penumbra about the same width in metres
    sh.radius = p.mapSize >= 2048 ? 2.6 : 1.6;
    sh.bias = -0.00015;
    sh.normalBias = p.mapSize >= 2048 ? 0.03 : 0.045;
    const prev = this.csm;
    const csm = new CSMShadowNode(this.sun, { cascades: p.cascades, maxFar: p.far, mode: 'practical', lightMargin: 120 });
    csm.fade = true;
    sh.shadowNode = csm;
    this.csm = csm;
    if (prev) prev.dispose();
    return !!prev;
  }

  /** Blend clear (0) → storm (1). Cheap: lights, uniforms and exposure only (no shader or env-map rebuild). */
  setWeather(t: number) {
    if (!Number.isFinite(t)) { console.warn(`[world/lighting] setWeather(${t}) ignored`); return; }
    t = Math.min(1, Math.max(0, t));
    this.weather = t;
    const L = THREE.MathUtils.lerp;
    const C = (a: THREE.Color, b: THREE.Color, out: THREE.Color) => out.copy(a).lerp(b, t);
    this.sun.intensity = L(CLEAR.sun, STORM.sun, t);
    C(CLEAR.sunColor, STORM.sunColor, this.sun.color);
    this.hemi.intensity = L(CLEAR.hemi, STORM.hemi, t);
    C(CLEAR.hemiSky, STORM.hemiSky, this.hemi.color);
    C(CLEAR.hemiGround, STORM.hemiGround, this.hemi.groundColor);
    this.scene.environmentIntensity = this.envIntensity();
    this.gpu.toneMappingExposure = L(CLEAR.exposure, STORM.exposure, t);
    const u = this.u;
    u.skyGain.value = L(CLEAR.skyGain, STORM.skyGain, t);
    u.skySaturation.value = L(CLEAR.skySat, STORM.skySat, t);
    this.sky.turbidity.value = L(CLEAR.turbidity, STORM.turbidity, t);
    this.sky.rayleigh.value = L(CLEAR.rayleigh, STORM.rayleigh, t);
    this.sky.cloudCoverage.value = L(CLEAR.clouds, STORM.clouds, t);
    this.sky.cloudDensity.value = L(CLEAR.cloudDensity, STORM.cloudDensity, t);
    this.sky.showSunDisc.value = t < 0.6 ? 1 : 0;
    C(CLEAR.haze, STORM.haze, u.hazeColor.value);
    C(CLEAR.hazeSun, STORM.hazeSun, u.hazeSunColor.value);
    u.hazeDensity.value = L(CLEAR.hazeDensity, STORM.hazeDensity, t);
    glint.value = Math.pow(1 - t, 2);
  }

  dispose() {
    this.csm?.dispose();
    if (lighting.current === this) lighting.current = null;
  }
}

/** The live lighting rig (set when the renderer starts). */
export const lighting: { current: Lighting | null } = { current: null };
let pendingWeather: number | null = null;

/** Blend the scene lighting clear (0) → storm (1). Before the renderer exists, the value is applied on creation. */
export function setWeather(t: number) {
  pendingWeather = t;
  lighting.current?.setWeather(t);
}

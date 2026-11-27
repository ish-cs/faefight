import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, exp, float, fog, luminance, max, mix, normalize, pmremTexture, positionView, positionWorld, pow, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { perfOff } from './perfFlags';
import { dayLook, type DayLook, type Rgb } from './dayCycle';
import { lightU } from './lightUniforms';

/**
 * The scene's lighting rig in one place: sky dome, image-based lighting (PMREM of the sky above a sand/sea bounce
 * hemisphere), warm key sun with cascaded shadows, a hemisphere fill tinted by sand and water, aerial-perspective
 * haze and the tone-mapping exposure. Everything time- and weather-dependent is a uniform or light property, set
 * from two inputs:
 *   - `setDay(look)`: the day/night cycle (dayNight.ts / dayCycle.ts). The rig's own clear-weather key (CLEAR, tuned
 *     for late morning) is scaled by how the cycle's look at that moment differs from its own phase 0: golden hour,
 *     dusk and night keep the rig's balance (sun vs hemisphere vs IBL) while following the cycle.
 *   - `setWeather(t)`: blends that day key toward a dark rain squall (t = 1). The squall is night-aware: it never
 *     lights the scene more than the time of day does, its haze darkens with the night, and its clouds hide the stars.
 * No shader or environment-map rebuild either way.
 *
 * For other systems (storm, water, viewmodel):
 *   - `SUN_DIR` direction toward the late-morning sun (env map, impostor bake and viewmodel use it; the live sun is
 *     lightU.sunDir / lightU.keyDir, moved by the day/night cycle)
 *   - `lighting.current` the live rig (null before the renderer starts): `.sun`, `.hemi`, `.u` (uniforms), `.weather`, `.night`
 *   - `setWeather(t)` module-level shortcut; safe to call before the rig exists (applied when it's created)
 */

/** Late-morning sun ≈ 38° elevation (the day/night cycle's phase 0). */
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(58));

type WeatherKey = {
  sun: number; sunColor: THREE.Color;
  hemi: number; hemiSky: THREE.Color; hemiGround: THREE.Color;
  env: number; exposure: number; envTint: THREE.Color;
  skyGain: number; skySat: number; turbidity: number; rayleigh: number; clouds: number; cloudDensity: number;
  haze: THREE.Color; hazeSun: THREE.Color; hazeDensity: number;
};
const CLEAR: WeatherKey = {
  sun: 7.8, sunColor: new THREE.Color(0xffdfb4),
  // sky-blue from above, warm sand + teal sea bounce from below
  hemi: 0.2, hemiSky: new THREE.Color(0xbcd6f0), hemiGround: new THREE.Color(0xb8a27a).lerp(new THREE.Color(0x4f7f86), 0.35),
  env: 0.68, exposure: 0.572, envTint: new THREE.Color(1, 1, 1),
  skyGain: 0.7, skySat: 1.12, turbidity: 3, rayleigh: 1.5, clouds: 0.35, cloudDensity: 0.5,
  haze: new THREE.Color(0xa6c3dc), hazeSun: new THREE.Color(0xf6dcb0), hazeDensity: 0.0012,
};
const STORM: WeatherKey = {
  sun: 0.5, sunColor: new THREE.Color(0xa8b4c4),
  hemi: 0.75, hemiSky: new THREE.Color(0x7c8a9a), hemiGround: new THREE.Color(0x3c4a50),
  env: 0.3, exposure: 0.682, envTint: new THREE.Color(1, 1, 1),
  skyGain: 0.24, skySat: 0.12, turbidity: 10, rayleigh: 0.4, clouds: 1, cloudDensity: 1,
  haze: new THREE.Color(0x5f6a74), hazeSun: new THREE.Color(0x707a84), hazeDensity: 0.0065,
};

const WHITE = new THREE.Color(1, 1, 1);
/** Extra exposure at full night (× 1 + this). */
const NIGHT_LIFT = 0.25;
/** How far the ambient (IBL) colour follows the haze hue away from the noon sky it was baked from (0..1). */
const ENV_TINT = 0.45;
const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722), tmpV = new THREE.Vector3();

/** The cycle's phase-0 look (= late morning, what CLEAR is tuned for): setDay scales CLEAR by look ÷ this. */
const DAY0 = dayLook(0);
const tmpA = new THREE.Color(), tmpB = new THREE.Color();
/** out = base × (look ÷ ref) per linear channel (`hueOnly`: the ratio normalised to its largest channel). */
function ratioTint(base: THREE.Color, look: Rgb, ref: Rgb, out: THREE.Color, hueOnly = false) {
  const a = tmpA.setRGB(look[0], look[1], look[2], THREE.SRGBColorSpace), b = tmpB.setRGB(ref[0], ref[1], ref[2], THREE.SRGBColorSpace);
  let r = a.r / Math.max(b.r, 1e-4), g = a.g / Math.max(b.g, 1e-4), bl = a.b / Math.max(b.b, 1e-4);
  if (hueOnly) { const m = Math.max(r, g, bl, 1e-4); r /= m; g /= m; bl /= m; }
  return out.setRGB(base.r * r, base.g * g, base.b * bl);
}
const cloneKey = (k: WeatherKey): WeatherKey => ({
  ...k, envTint: k.envTint.clone(), sunColor: k.sunColor.clone(), hemiSky: k.hemiSky.clone(), hemiGround: k.hemiGround.clone(), haze: k.haze.clone(), hazeSun: k.hazeSun.clone(),
});

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
    /**
     * Colour of the image-based ambient for the time of day (linear, ~1 at the brightest channel). The env map is
     * baked once from the late-morning sky; without this, golden hour and dusk shade every surface in noon blue
     * (backlit sunset ground read as lavender snow). Intensity stays scene.environmentIntensity.
     */
    envTint: uniform(new THREE.Color(1, 1, 1)),
  };
  /**
   * The scene's IBL: the PMREM'd sky env map × envTint. Set as scene.environmentNode (and the water's envNode), so
   * the tint is a uniform: changing the time of day never recompiles.
   */
  envNode: THREE.Node<'vec3'> | null = null;
  private envPmrem: ReturnType<typeof pmremTexture> | null = null;
  /** current weather 0 (clear) .. 1 (storm) */
  weather = 0;
  /** time of day: 0 day → 1 night (setDay) */
  night = 0;
  /** clear-weather key for the current time of day (setDay); setWeather blends it toward the squall */
  private day = cloneKey(CLEAR);
  /** the storm key for the current time of day (apply's scratch) */
  private squall = cloneKey(STORM);
  /** water glint colour × strength for the time of day, before the storm dims it */
  private dayGlint = new THREE.Vector3(1, 1, 1);
  /** the cascaded shadow node (sky.ts culls small casters out of its far cascades and caches them) */
  csm: CSMShadowNode | null = null;

  constructor(private gpu: THREE.WebGPURenderer, private scene: THREE.Scene) {
    // Khronos PBR Neutral: linear up to ~0.76, then a soft shoulder with little hue shift. Keeps base colours and the
    // blue sky honest (ACES washed the noon frame out and pushed sunsets to yellow); the grade (post.ts) adds contrast.
    gpu.toneMapping = THREE.NeutralToneMapping;
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
    scene.add(s, s.target);
    if (!perfOff('nohemi')) scene.add(this.hemi);

    // Aerial perspective: exponential distance haze that thins with altitude (so the far sea and hills soften toward
    // the horizon while nearby props stay crisp), warmer when looking toward the sun.
    const u = this.u;
    const viewDir = normalize(positionWorld.sub(cameraPosition));
    const toSun = pow(max(dot(viewDir, lightU.sunDir), 0), 6);
    const dist = positionView.z.negate();
    const heightK = exp(max(positionWorld.y, 0).mul(u.hazeHeightFalloff).negate());
    // a little extra density past ~250 m: the horizon line melts into the sky instead of a hard sea edge
    const far = smoothstep(250, 900, dist).mul(0.25);
    const amount = float(1).sub(exp(dist.mul(u.hazeDensity).mul(heightK).negate())).add(far).clamp(0, 1);
    scene.fogNode = fog(mix(u.hazeColor, u.hazeSunColor, toSun.mul(0.6)), amount);

    lighting.current = this;
    this.setWeather(pendingWeather ?? 0);
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
      if (this.envPmrem) this.envPmrem.value = this.scene.environment;
      else if (!perfOff('noenvtint')) {
        this.envPmrem = pmremTexture(this.scene.environment);
        this.envNode = this.envPmrem.mul(this.u.envTint);
        this.scene.environmentNode = this.envNode;
      }
      this.scene.environmentIntensity = this.envIntensity();
      pmrem.dispose();
    } catch (err) {
      console.warn('[world/lighting] sky environment map unavailable, leaning on the hemisphere light', err);
      this.hemi.intensity = 1.2;
    }
  }

  private envIntensity() { return THREE.MathUtils.lerp(this.day.env, this.squall.env, this.weather); }

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

  /**
   * Time of day (dayNight.ts, whenever the cycle's look changes). CLEAR scaled by the look relative to the cycle's
   * phase 0: light, ambient (IBL + hemisphere), exposure and haze follow the cycle; the sky's shape stays the rig's.
   */
  setDay(look: DayLook) {
    const d = this.day, r = DAY0, k = look.light / r.light, amb = look.env / r.env;
    d.sun = CLEAR.sun * k;
    ratioTint(CLEAR.sunColor, look.lightC, r.lightC, d.sunColor);
    d.hemi = CLEAR.hemi * amb;
    ratioTint(CLEAR.hemiSky, look.haze, r.haze, d.hemiSky, true);
    // ambient hue follows the sky haze (warmer golden hour, mauve dusk, blue night), part of the way; hue only (unit
    // luminance): how bright the ambient is stays look.env
    ratioTint(WHITE, look.haze, r.haze, d.envTint);
    d.envTint.multiplyScalar(1 / Math.max(1e-4, LUMA.dot(tmpV.set(d.envTint.r, d.envTint.g, d.envTint.b)))).lerp(WHITE, 1 - ENV_TINT);
    d.env = CLEAR.env * amb;
    d.exposure = CLEAR.exposure * (look.exposure / r.exposure);
    d.skyGain = CLEAR.skyGain * (look.skyGain / r.skyGain);
    d.skySat = CLEAR.skySat * (look.skySat / r.skySat);
    ratioTint(CLEAR.haze, look.haze, r.haze, d.haze);
    ratioTint(CLEAR.hazeSun, look.hazeSun, r.hazeSun, d.hazeSun);
    d.hazeDensity = CLEAR.hazeDensity * (look.density / r.density);
    this.night = look.night;
    // sun sparkle on the water → a fainter, cooler moon path
    const g = Math.min(1, k * (1 + 3 * look.night)), c = d.sunColor;
    this.dayGlint.set(c.r / CLEAR.sunColor.r * g, c.g / CLEAR.sunColor.g * g, c.b / CLEAR.sunColor.b * g);
    this.apply();
  }

  /** Blend clear (0) → storm (1) on top of the time of day. Cheap: lights, uniforms and exposure only. */
  setWeather(t: number) {
    if (!Number.isFinite(t)) { console.warn(`[world/lighting] setWeather(${t}) ignored`); return; }
    this.weather = Math.min(1, Math.max(0, t));
    this.apply();
  }

  /**
   * The squall for this time of day: never more key light or IBL than the day key has, overcast fill that follows
   * the day's ambient, haze darkened by the night (a night storm reads as a stormy night, not a grey day or double
   * darkness). Then lerp day → squall by the weather.
   */
  private apply() {
    const d = this.day, q = this.squall, t = this.weather, n = this.night;
    const dark = 1 - 0.55 * n;
    q.sun = Math.min(d.sun, STORM.sun);
    q.hemi = Math.max(d.hemi, STORM.hemi * (d.env / CLEAR.env));
    q.env = Math.min(d.env, STORM.env);
    q.exposure = d.exposure * (STORM.exposure / CLEAR.exposure);
    q.skyGain = Math.min(d.skyGain, STORM.skyGain);
    q.skySat = Math.min(d.skySat, STORM.skySat);
    q.haze.copy(STORM.haze).multiplyScalar(dark);
    q.hazeSun.copy(STORM.hazeSun).multiplyScalar(dark);
    q.hazeDensity = Math.max(d.hazeDensity, STORM.hazeDensity);
    q.envTint.copy(d.envTint).lerp(WHITE, 0.5); // overcast: greyer ambient

    const L = THREE.MathUtils.lerp;
    const C = (a: THREE.Color, b: THREE.Color, out: THREE.Color) => out.copy(a).lerp(b, t);
    this.sun.intensity = L(d.sun, q.sun, t);
    C(d.sunColor, q.sunColor, this.sun.color);
    this.hemi.intensity = L(d.hemi, q.hemi, t);
    C(d.hemiSky, q.hemiSky, this.hemi.color);
    C(d.hemiGround, q.hemiGround, this.hemi.groundColor);
    this.scene.environmentIntensity = this.envIntensity();
    C(d.envTint, q.envTint, this.u.envTint.value);
    // Neutral has no toe lift (ACES had): open up a little more as night falls so the dark stays readable
    this.gpu.toneMappingExposure = L(d.exposure, q.exposure, t) * (1 + NIGHT_LIFT * n);
    const u = this.u;
    u.skyGain.value = L(d.skyGain, q.skyGain, t);
    u.skySaturation.value = L(d.skySat, q.skySat, t);
    this.sky.turbidity.value = L(d.turbidity, q.turbidity, t);
    this.sky.rayleigh.value = L(d.rayleigh, q.rayleigh, t);
    this.sky.cloudCoverage.value = L(d.clouds, q.clouds, t);
    this.sky.cloudDensity.value = L(d.cloudDensity, q.cloudDensity, t);
    this.sky.showSunDisc.value = t < 0.6 ? 1 : 0;
    C(d.haze, q.haze, u.hazeColor.value);
    C(d.hazeSun, q.hazeSun, u.hazeSunColor.value);
    u.hazeDensity.value = L(d.hazeDensity, q.hazeDensity, t);
    // storm clouds hide the stars and moon (lightning still shows through the dark sky gain)
    lightU.night.value = n * (1 - 0.85 * t);
    (lightU.glint.value as THREE.Vector3).copy(this.dayGlint).multiplyScalar((1 - t) * (1 - t));
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

import * as THREE from 'three/webgpu';
import { color, float, uv } from 'three/tsl';
import type { CosmeticDef } from '../../sim/map';
import { dayLook, dayPhase, lightAngles, lightStepPhase, newDayLook, type Rgb } from './dayCycle';
import { dayNightState, lightU } from './lightUniforms';
import type { SkyLighting } from './sky';

/** Clear-weather lighting of the moment: what the storm (storm.ts) darkens from. */
export type Weather = {
  sunI: number; sunC: THREE.Color; skyGain: number; skySat: number; haze: THREE.Color; hazeSun: THREE.Color;
  density: number; env: number; exposure: number;
  /** 0 = day → 1 = night */
  night: number;
};

/** The day sun the impostors were baked under (sky.ts phase 0): impostor tint = current light ÷ this. */
const BAKE = { light: 6, color: new THREE.Color(0xffe9cc), env: 0.8 };

const rad = THREE.MathUtils.degToRad;
const setSrgb = (c: THREE.Color, v: Rgb) => c.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);

/**
 * Applies the day/night cycle (dayCycle.ts) to the world lighting each frame: sky dome sun, key light (sun → moon),
 * haze, ambient, exposure, lamps, night sky, water glints and impostor tint. Scalar and uniform writes only; the key
 * light (the shadow caster) moves in DAY_CYCLE.lightStepSec steps (cached far cascades redraw then, one per frame).
 * Runs before StormFx, which darkens from `base` instead of a fixed daytime baseline.
 */
export class DayNight {
  readonly base: Weather;
  private sdAt: number | null = null;
  private lastP = -1;
  private lastComp = false;
  private lastStep = -1;
  private look = newDayLook();
  private dir = new THREE.Vector3();
  private tmpC = new THREE.Color();

  constructor(private sky: SkyLighting, private gpu: THREE.WebGPURenderer, private scene: THREE.Scene) {
    this.base = {
      sunI: 0, sunC: new THREE.Color(), skyGain: 0, skySat: 0, haze: new THREE.Color(), hazeSun: new THREE.Color(),
      density: 0, env: 0, exposure: 0, night: 0,
    };
    const m = lightAngles(1);
    lightU.moonDir.value.setFromSphericalCoords(1, rad(90 - m.elev), rad(m.az));
    this.frame(0, false);
  }

  /** The match's sudden-death time (lobby setting): night falls at it. null = no cycle (practice, menus): day. */
  setCycle(suddenDeathAt: number | null) {
    this.sdAt = suddenDeathAt;
    this.lastP = this.lastStep = -1;
  }

  /** Phase now (debug / tests). */
  get phase(): number { return this.lastP; }

  /** Per frame, before StormFx.frame. `time` = match time (s), the same clock on every client and in replays. */
  frame(time: number, suddenDeath: boolean) {
    const cycle = this.sdAt !== null;
    const p = cycle && suddenDeath ? 1 : dayPhase(time, this.sdAt);
    const pq = cycle && suddenDeath ? 1 : lightStepPhase(time, this.sdAt);
    if (pq !== this.lastStep) {
      this.lastStep = pq;
      const a = lightAngles(pq);
      this.sky.setLightDir(this.dir.setFromSphericalCoords(1, rad(90 - a.elev), rad(a.az)));
    }
    const comp = this.sky.isCompetitive;
    if (p === this.lastP && comp === this.lastComp) return;
    this.lastP = p;
    this.lastComp = comp;
    const L = dayLook(p, comp, this.look);
    const s = this.sky, b = this.base;

    s.setSunDir(this.dir.setFromSphericalCoords(1, rad(90 - L.sunElev), rad(L.sunAz)));
    b.sunI = L.light;
    setSrgb(b.sunC, L.lightC);
    b.skyGain = L.skyGain;
    b.skySat = L.skySat;
    setSrgb(b.haze, L.haze);
    setSrgb(b.hazeSun, L.hazeSun);
    b.density = L.density;
    b.env = L.env;
    b.exposure = L.exposure;
    b.night = L.night;

    s.sun.intensity = b.sunI;
    s.sun.color.copy(b.sunC);
    s.skyGain.value = b.skyGain;
    s.skySaturation.value = b.skySat;
    (s.haze.color.value as THREE.Color).copy(b.haze);
    (s.haze.sunColor.value as THREE.Color).copy(b.hazeSun);
    s.haze.density.value = b.density;
    this.scene.environmentIntensity = b.env;
    this.gpu.toneMappingExposure = b.exposure;

    lightU.lamps.value = L.lamps;
    lightU.night.value = L.night;
    lightU.twilight.value = L.twilight;
    // sun sparkle → a fainter, cooler moon path on the water
    const k = L.light / BAKE.light;
    const g = Math.min(1, k * (1 + 3 * L.night));
    (lightU.glint.value as THREE.Vector3).set(b.sunC.r / BAKE.color.r * g, b.sunC.g / BAKE.color.g * g, b.sunC.b / BAKE.color.b * g);
    // impostors: baked under the day sun + ambient; scale each part by how much of it is left
    const t = this.tmpC.copy(b.sunC);
    t.r /= BAKE.color.r; t.g /= BAKE.color.g; t.b /= BAKE.color.b;
    t.multiplyScalar(0.6 * k).addScalar(0.4 * (b.env / BAKE.env));
    (lightU.impostor.value as THREE.Color).copy(t);
    dayNightState.night = L.night;
    dayNightState.key = k;
    dayNightState.env = b.env / BAKE.env;
    dayNightState.keyColor.copy(b.sunC);
  }
}

/** Ground pool under a lamp head: radius (m) and peak added radiance (scene-linear, before exposure). */
const POOL = { radius: 5.5, peak: 0.16, color: new THREE.Color(1, 0.72, 0.42) };

/**
 * Light pools under the lamps (the "baked" part of the lamp light): one instanced additive disc per lamp, faded in
 * with lightU.lamps. One draw call for every lamp on the map, no real lights (each point light would cost every lit
 * pixel). Broken lamps (cosmetics) lose their pool.
 */
export class LampPools {
  readonly mesh: THREE.InstancedMesh;
  private ids: number[] = [];
  private brokenKey = '';

  constructor(harbor: THREE.Vector3[], cosmetics: CosmeticDef[]) {
    const spots: { x: number; y: number; z: number; id: number }[] = harbor.map((v) => ({ x: v.x, y: v.y, z: v.z, id: -1 }));
    for (const c of cosmetics) {
      if (c.kind !== 'lamp') continue;
      // lampModel's head hangs 0.82 m out along the lamp's local +x
      spots.push({ x: c.pos.x + Math.cos(c.rotY) * 0.82, y: c.pos.y, z: c.pos.z - Math.sin(c.rotY) * 0.82, id: c.id });
    }
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, polygonOffset: true, polygonOffsetFactor: -2 });
    mat.name = 'lampPool';
    const r = uv().sub(0.5).length().mul(2);
    const fall = float(1).sub(r.mul(r)).max(0);
    mat.colorNode = color(POOL.color).mul(fall.mul(fall).mul(POOL.peak).mul(lightU.lamps));
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, Math.max(1, spots.length));
    this.mesh.name = 'lampPools';
    this.mesh.count = spots.length;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 2;
    const m = new THREE.Matrix4();
    spots.forEach((s, i) => {
      this.mesh.setMatrixAt(i, m.makeScale(POOL.radius * 2, 1, POOL.radius * 2).setPosition(s.x, s.y + 0.03, s.z));
      this.ids.push(s.id);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Hide the pools of broken lamps (snapshot state). Cheap when nothing changed. */
  sync(broken: readonly number[]) {
    const key = broken.length ? `${broken.length}:${broken[0]}:${broken[broken.length - 1]}` : '';
    if (key === this.brokenKey) return;
    this.brokenKey = key;
    const set = new Set(broken), m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    this.ids.forEach((id, i) => {
      if (id < 0) return;
      this.mesh.getMatrixAt(i, m);
      m.decompose(p, q, sc);
      const on = !set.has(id);
      m.makeScale(on ? POOL.radius * 2 : 0, 1, on ? POOL.radius * 2 : 0).setPosition(p);
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

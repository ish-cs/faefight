import * as THREE from 'three/webgpu';
import { cameraPosition, float, hash, instanceIndex, mix, positionLocal, sin, smoothstep, time, uniform, uv, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP, STORM } from '../../sim/constants';
import type { IslandLayout } from '../../sim/map';
import type { StormSnap, Vec3 } from '../../sim/types';
import type { Quality, SkyLighting } from './sky';
import { stepWetness, WET, wetness, wetOverride } from './wetness';

/** WebGPURenderer tone-maps unlit materials too: pre-boost so the bolt and wall read bright. */
const BOOST = 2.6;
/** Rain drops kept around the camera, per quality preset (GPU-instanced, positions computed in the vertex shader). */
const RAIN_DROPS: Record<Quality, number> = { low: 1500, high: 4000, ultra: 7000 };
const RAIN_BOX = 36, RAIN_H = 22;
const WALL_H = 110;
const MARKERS = 10;
const BOLT_MS = 240;


/**
 * Sudden-death weather on the client: the storm wall (an animated open cylinder at the ring), dark rainy sky and sun,
 * GPU-instanced rain near the camera, telegraph markers under announced strikes, and lightning bolts with a scene-wide
 * flash. Pure presentation: everything it shows comes from the snapshot's `storm` and `lightning` events.
 */
export class StormFx {
  readonly root = new THREE.Group();
  /** 0 = clear day, 1 = full storm; eases in over a few seconds at sudden death. */
  private wet = 0;
  private target = 0;
  private flashAt = -1e9;
  private flashPeak = 0;
  private storm: StormSnap | null = null;
  /** Land to put strike markers on: player islands and the center island. */
  private land: { center: Vec3; radius: number; groundY: number }[] = [];
  private readonly wall: THREE.Mesh;
  private readonly wallOpacity = uniform(0);
  private readonly rain: THREE.InstancedMesh;
  private readonly rainAmt = uniform(0);
  private readonly markers: { ring: THREE.Mesh; disc: THREE.Mesh; ringMat: THREE.MeshBasicNodeMaterial; discMat: THREE.MeshBasicNodeMaterial }[] = [];
  private bolts: { mesh: THREE.Mesh; born: number }[] = [];
  private boltMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xd8e4ff).multiplyScalar(BOOST * 1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  private stormHazeOut = new THREE.Color(0x4a3a6e);
  private tmpC = new THREE.Color();
  private tmpH = new THREE.Color();
  private weatherDirty = false;
  /** Ground wetness (wetness.ts): soaks in behind the rain, dries slowly after; ?wet= pins it. */
  private soak = 0;
  private readonly wetPin = wetOverride();
  /** Perf debugging (tests/visual/storm.mjs): hide one part. */
  debugHide: 'rain' | 'wall' | null = null;

  constructor(private sky: SkyLighting, private gpu: THREE.WebGPURenderer, private scene: THREE.Scene) {
    this.root.name = 'storm';

    // Storm wall: violet streaks drifting sideways, fading out toward the top.
    const wallMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const u = uv();
    const streak = sin(u.x.mul(700).add(u.y.mul(30)).add(time.mul(2.5))).mul(0.5).add(0.5);
    const band = sin(u.x.mul(61).sub(time.mul(0.6)).add(u.y.mul(4))).mul(0.5).add(0.5);
    const k = streak.mul(band);
    wallMat.colorNode = mix(vec3(0.2, 0.1, 0.45), vec3(0.62, 0.5, 1.0), k).mul(1.8);
    wallMat.opacityNode = float(0.32).add(k.mul(0.3)).mul(smoothstep(0, 0.04, u.y)).mul(float(1).sub(smoothstep(0.55, 1, u.y))).mul(this.wallOpacity);
    this.wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 128, 1, true).translate(0, 0.5, 0), wallMat);
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 5;
    this.wall.visible = false;
    this.root.add(this.wall);

    // Rain: two crossed thin quads per drop; each instance wraps around the camera in a world-fixed lattice
    // (drops don't swim when you turn or walk) and falls at its own speed.
    const drop = new THREE.PlaneGeometry(0.016, 0.6);
    const rainGeo = mergeGeometries([drop, drop.clone().rotateY(Math.PI / 2)]);
    const rainMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xb8c4d4).multiplyScalar(1.4), transparent: true, depthWrite: false, fog: false });
    const id = float(instanceIndex);
    const rx = hash(id), rz = hash(id.add(17.31)), ry = hash(id.add(5.77)), sp = hash(id.add(3.1));
    const cam = cameraPosition;
    const half = RAIN_BOX / 2;
    const wx = cam.x.sub(half).add(rx.mul(RAIN_BOX).sub(cam.x).mod(RAIN_BOX));
    const wz = cam.z.sub(half).add(rz.mul(RAIN_BOX).sub(cam.z).mod(RAIN_BOX));
    const fall = time.mul(sp.mul(5).add(15));
    const wy = cam.y.sub(RAIN_H * 0.4).add(ry.mul(RAIN_H).sub(fall).sub(cam.y).mod(RAIN_H));
    // A little wind slant: the top of each streak leans downwind.
    rainMat.positionNode = vec3(wx, wy, wz).add(positionLocal).add(vec3(positionLocal.y.mul(0.18), 0, positionLocal.y.mul(0.06)));
    rainMat.opacityNode = float(0.32).mul(this.rainAmt);
    this.rain = new THREE.InstancedMesh(rainGeo, rainMat, RAIN_DROPS.ultra);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.count = RAIN_DROPS[sky.quality];
    this.root.add(this.rain);

    // Telegraph: a bright ring at the strike radius and a disc that fills it as the strike gets close.
    const ringGeo = new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2);
    const discGeo = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
    for (let i = 0; i < MARKERS; i++) {
      const ringMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xbfd8ff).multiplyScalar(BOOST), transparent: true, depthWrite: false, fog: false });
      const discMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0x8fb0ff).multiplyScalar(BOOST), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
      const ring = new THREE.Mesh(ringGeo, ringMat), disc = new THREE.Mesh(discGeo, discMat);
      ring.visible = disc.visible = false;
      ring.renderOrder = disc.renderOrder = 6;
      ring.name = 'strikeMarker';
      this.markers.push({ ring, disc, ringMat, discMat });
      this.root.add(ring, disc);
    }
    scene.add(this.root);
  }

  setMap(map: IslandLayout[], center?: { center: Vec3; radius: number; groundY: number } | null) { this.land = center ? [...map, center] : [...map]; }

  /** Ground height a marker sits on: island top, else the sea. */
  private groundY(x: number, z: number): number {
    for (const isl of this.land) if (Math.hypot(x - isl.center.x, z - isl.center.z) <= isl.radius) return isl.groundY;
    return MAP.waterY;
  }

  /** Latest snapshot state (null before sudden death). */
  sync(storm: StormSnap | null | undefined, suddenDeath: boolean) {
    this.storm = storm ?? null;
    this.target = suddenDeath ? 1 : 0;
  }

  /** A `lightning` event: bolt + flash (stronger the closer it is). */
  strike(pos: Vec3, camera: THREE.Camera) {
    const now = performance.now();
    const d = Math.hypot(pos.x - camera.position.x, pos.z - camera.position.z);
    this.flashAt = now;
    this.flashPeak = Math.max(0.35, Math.min(1, 60 / (d + 20)));
    const pts: THREE.Vector3[] = [];
    const top = 140, n = 16;
    let ox = 0, oz = 0;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      if (i > 0 && i < n) { ox += (Math.random() - 0.5) * 10 * (1 - k * 0.6); oz += (Math.random() - 0.5) * 10 * (1 - k * 0.6); }
      pts.push(new THREE.Vector3(pos.x + (i === n ? 0 : ox), pos.y + top * (1 - k), pos.z + (i === n ? 0 : oz)));
    }
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < n; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, n * 2, 0.13, 4, false), this.boltMat);
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.bolts.push({ mesh, born: now });
  }

  /** Per frame, before the world draws. */
  frame(dt: number, camera: THREE.Camera, quality: Quality, simTime: number) {
    const now = performance.now();
    this.wet += (this.target - this.wet) * Math.min(1, dt / 2.5);
    if (this.target === 0 && this.wet < 0.003) this.wet = 0;
    const w = this.wet;
    this.soak = stepWetness(this.soak, Math.max(w, this.sky.lighting.night * WET.nightDew), dt);
    wetness.value = this.wetPin ?? this.soak;

    // Flash: a bright pulse with a second flicker ~150 ms later.
    const ft = (now - this.flashAt) / 1000;
    const flash = this.flashPeak * (Math.exp(-ft / 0.07) + (ft > 0.14 ? 0.6 * Math.exp(-(ft - 0.14) / 0.09) : 0));

    const st = this.storm;
    const outside = st ? Math.hypot(camera.position.x - st.x, camera.position.z - st.z) > st.r : false;
    this.applyWeather(w, flash, outside);

    // Wall
    this.wall.visible = !!st && w > 0.01;
    if (st) {
      this.wall.position.set(st.x, MAP.waterY - 4, st.z);
      this.wall.scale.set(st.r, WALL_H, st.r);
      this.wallOpacity.value = w;
    }

    if (this.debugHide === 'wall') this.wall.visible = false;

    // Rain
    this.rain.visible = w > 0.02 && this.debugHide !== 'rain';
    this.rainAmt.value = w;
    this.rain.count = RAIN_DROPS[quality];

    // Telegraph markers for strikes not yet landed.
    const strikes = st?.strikes ?? [];
    this.markers.forEach((m, i) => {
      const s = strikes[i];
      const on = !!s && s.at >= simTime - 0.05;
      m.ring.visible = m.disc.visible = on;
      if (!on) return;
      const k = Math.min(1, Math.max(0, 1 - (s.at - simTime) / STORM.telegraphSec));
      const y = this.groundY(s.x, s.z) + 0.06;
      m.ring.position.set(s.x, y, s.z);
      m.ring.scale.setScalar(STORM.boltRadius);
      m.disc.position.set(s.x, y + 0.01, s.z);
      m.disc.scale.setScalar(Math.max(0.05, STORM.boltRadius * k));
      const pulse = 0.5 + 0.5 * Math.sin(now / 60);
      m.ringMat.opacity = 0.55 + 0.45 * pulse;
      m.discMat.opacity = 0.18 + 0.35 * k;
    });

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const age = now - b.born;
      if (age > BOLT_MS) { this.root.remove(b.mesh); b.mesh.geometry.dispose(); this.bolts.splice(i, 1); continue; }
      b.mesh.visible = age < 70 || (age > 120 && age < 200);
    }
  }

  /**
   * Storm lighting = the lighting rig's own weather blend on top of the time of day (world/lighting.ts setWeather:
   * sun, sky, env, exposure, haze, stars hidden; night-aware) plus this module's extras: lightning flashes (harder at
   * night, when they light a dark scene) and the violet haze outside the storm wall.
   */
  private applyWeather(w: number, flash: number, outside: boolean) {
    const s = this.sky;
    // Clear weather: DayNight owns the lighting; after one exact restore to its current time of day, leave it alone.
    if (w === 0 && flash < 0.001) { if (!this.weatherDirty) return; this.weatherDirty = false; } else this.weatherDirty = true;
    s.setWeather(w);
    const L = s.lighting, f = flash * (1 + 0.8 * L.night);
    if (outside) {
      (L.u.hazeColor.value as THREE.Color).lerp(this.tmpH.copy(this.stormHazeOut).multiplyScalar(1 - 0.55 * L.night), w);
      L.u.hazeDensity.value = (L.u.hazeDensity.value as number) * (1 + w);
    }
    if (f > 0.001) {
      L.sun.intensity += f * 16;
      L.u.skyGain.value = (L.u.skyGain.value as number) + f * 0.9;
      (L.u.hazeColor.value as THREE.Color).lerp(this.tmpC.set(0xc8d0ff), Math.min(1, f * 0.6));
      this.scene.environmentIntensity += f * 0.9;
      this.gpu.toneMappingExposure += f * 0.2;
    }
  }

}

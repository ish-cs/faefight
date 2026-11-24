import * as THREE from 'three/webgpu';
import {
  abs, attribute, positionLocal, cameraFar, instancedDynamicBufferAttribute, cameraNear, cos, exp, float, max, min, mix, positionGeometry, positionView, sin,
  uniform, vec3, viewZToPerspectiveDepth,
  mx_noise_float, mx_worley_noise_float, normalLocal, smoothstep, uv, vec2, vertexColor,
} from 'three/tsl';
import type { MapDef } from '../../sim/map';
import type { MatchEvent, Vec3 } from '../../sim/types';
import { buildHabitats, type Habitats, type PerchIn } from './critterHabitats';
import { critterGeometry, TINTS } from './critterMeshes';
import { staticVelocity } from './velocity';
import { type Agent, type CritterQuality, CritterSim, type CritterSound, type V3 } from './critterSim';
import { SPECIES_DEFS, SWARM_DEFS, type SpeciesDef, type SwarmDef } from './critterSpecies';

type F = THREE.Node<'float'>;
const isK = (kind: F, k: number) => float(1).sub(min(abs(kind.sub(k)), 1));

/**
 * Procedural limb animation shared by every species (see critterMeshes.ts for the `limb` encoding):
 * per-instance `crit` = (gait phase, gait 0..1, pose 0..1) written by the CPU each frame.
 *
 * NodeMaterial applies the instance matrix BEFORE `positionNode`, so positionLocal is already placed in the world
 * here: the limb offsets are computed in the model's own frame and turned into world space with the instance
 * matrix's columns (a second view of the same matrix array, `mats`). Building on positionGeometry instead would
 * drop the instance transform and draw every animal at the world origin.
 */
function animated(name: string, water: boolean, critAttr: THREE.InstancedBufferAttribute, mats: THREE.InstancedInterleavedBuffer): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: name === 'jelly' ? 0.2 : 0.8, side: THREE.DoubleSide });
  m.name = `critter:${name}`;
  const limb = attribute<'vec2'>('limb', 'vec2'), crit = instancedDynamicBufferAttribute(critAttr, 'vec3') as unknown as THREE.Node<'vec3'>;
  const kind = limb.x, amt = limb.y, phase = crit.x, gait = crit.y, pose = crit.z;
  const p = positionGeometry;
  const legA = isK(kind, 1), legB = isK(kind, 2), wing = isK(kind, 3), tail = isK(kind, 4), head = isK(kind, 5), pulse = isK(kind, 6);
  const ph = phase.add(legB.mul(Math.PI));
  const legs = legA.add(legB);
  const dz = sin(ph).mul(gait).mul(amt).mul(legs);
  const dyLeg = max(cos(ph), 0).mul(gait).mul(amt).mul(0.5).mul(legs);
  // wings: fold toward the body at rest, beat with the gait
  const fold = mix(float(1), mix(float(0.3), float(1), gait), wing);
  const dyWing = sin(phase).mul(amt).mul(gait).mul(0.6).mul(wing);
  const dxTail = sin(phase.mul(0.8)).mul(amt).mul(gait.mul(0.7).add(0.3)).mul(tail);
  const dyHead = pose.mul(amt).mul(head).negate();
  const swell = sin(phase).mul(amt).mul(0.3).mul(pulse).add(1);
  const off = vec3(p.x.mul(fold.mul(swell).sub(1)).add(dxTail), dyLeg.add(dyWing).add(dyHead), p.z.mul(swell.sub(1)).add(dz));
  const col = (k: number) => (instancedDynamicBufferAttribute(mats, 'vec4', 16, k * 4) as unknown as THREE.Node<'vec4'>).xyz;
  m.positionNode = positionLocal.add(col(0).mul(off.x)).add(col(1).mul(off.y)).add(col(2).mul(off.z));
  surface(m, name);
  if (water) underwater(m, name === 'jelly' ? 0.55 : 0.7);
  return m;
}

type Coat = 'fur' | 'feather' | 'scale' | 'shell' | 'none';
const COAT: Record<string, Coat> = {
  rat: 'fur', dog: 'fur',
  pigeon: 'feather', gull: 'feather', crow: 'feather', pelican: 'feather', cormorant: 'feather', heron: 'feather', parrot: 'feather',
  lizard: 'scale', gecko: 'scale', iguana: 'scale', fish: 'scale',
  crab: 'shell', hermit: 'shell', turtle: 'shell', starfish: 'shell',
};

/**
 * Procedural coat in model space (the pattern sticks to the animal as it moves): fine fur streaks / feather rows /
 * scale cells / mottled shell, broad mottling, countershading (darker back, lighter belly), darker legs, glossy
 * eyes (the near-black vertex colour), a warm translucent tint on thin pink parts (ears, feet), roughness from the
 * same noise. `colorNode` multiplies vertex × instance colour.
 */
function surface(m: THREE.MeshStandardNodeMaterial, name: string) {
  const coat = COAT[name] ?? 'none';
  if (coat === 'none') return;
  const P = positionGeometry, vc = vertexColor() as unknown as THREE.Node<'vec3'>;
  const limb = attribute<'vec2'>('limb', 'vec2');
  const legs = isK(limb.x, 1).add(isK(limb.x, 2));
  const mottle = mx_noise_float(P.mul(9)).mul(0.5).add(0.5);
  let pat: F;
  if (coat === 'fur') pat = mx_noise_float(vec3(P.x.mul(140), P.y.mul(140), P.z.mul(40))).mul(0.22).add(0.92).mul(mottle.mul(0.18).add(0.91));
  else if (coat === 'feather') {
    // overlapping feather rows down the body, each with a lighter edge
    const row = P.z.mul(38).add(mx_noise_float(P.mul(25)).mul(0.6)).fract();
    pat = smoothstep(0.55, 0.95, row).mul(0.16).add(0.9).mul(mottle.mul(0.12).add(0.94));
  } else if (coat === 'scale') {
    const cell = mx_worley_noise_float(P.mul(110)) as unknown as F;
    pat = smoothstep(0.05, 0.45, cell).mul(0.3).add(0.78).mul(mottle.mul(0.25).add(0.88));
  } else pat = mx_noise_float(P.mul(30)).mul(0.18).add(0.92).mul(mottle.mul(0.3).add(0.82));
  // countershading: up-facing back darker, belly lighter; legs and feet darker
  const back = normalLocal.y;
  const shade = mix(float(1.12), float(0.88), smoothstep(-0.6, 0.8, back)).mul(mix(float(1), float(0.72), legs));
  m.colorNode = vec3(pat.mul(shade));
  const lum = vc.x.add(vc.y).add(vc.z);
  const eye = float(1).sub(smoothstep(0.02, 0.06, lum));
  const base = coat === 'scale' ? 0.45 : coat === 'shell' ? 0.5 : coat === 'feather' ? 0.7 : 0.85;
  m.roughnessNode = mix(float(base).add(mottle.sub(0.5).mul(0.2)), float(0.06), eye);
  // warm back-lit tint on thin pinkish parts (ears, feet, tails): red clearly above green
  const pink = smoothstep(0.06, 0.18, vc.x.sub(vc.y)).mul(smoothstep(0.5, 0.9, vc.x));
  m.emissiveNode = vec3(0.9, 0.35, 0.3).mul(pink.mul(0.12));
}

/** Contact shadows: one instanced soft dark disc under every grounded animal (they don't cast real shadows). */
function blobMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  m.name = 'critter:blob';
  const d = uv().sub(vec2(0.5, 0.5)).length();
  m.colorNode = vec3(0, 0, 0);
  m.opacityNode = float(1).sub(smoothstep(0.12, 0.5, d)).mul(0.42);
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  return m;
}

/**
 * The ocean is opaque; things just under the surface are drawn translucent with their depth pulled 0.5 m toward the
 * camera, so they read through the top of the water but stay hidden behind quays and islands.
 */
function underwater(m: THREE.MeshStandardNodeMaterial, opacity: number) {
  m.transparent = true;
  m.opacity = opacity;
  m.depthWrite = false;
  const len = positionView.length();
  m.depthNode = viewZToPerspectiveDepth(positionView.z.mul(max(float(1).sub(float(0.5).div(len)), 0.02)), cameraNear, cameraFar);
}

type SpeciesMesh = { def: SpeciesDef; mesh: THREE.InstancedMesh; crit: THREE.InstancedBufferAttribute; mats: THREE.InstancedInterleavedBuffer; tinted: boolean };
type SwarmMesh = { def: SwarmDef; mesh: THREE.InstancedMesh; a: THREE.InstancedBufferAttribute; b: THREE.InstancedBufferAttribute };

const _m2 = new THREE.Matrix4(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _c = new THREE.Color();
const _fr = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sp = new THREE.Sphere();

/**
 * Wildlife: CritterSim agents (rats, pigeons, cats, dogs, crows, crabs, hermit crabs, a turtle, starfish, herons,
 * pelicans, cormorants, jellyfish, jumping fish, parrots, lizards, geckos, iguanas) as one InstancedMesh per
 * species, plus shader-driven swarms (flies, butterflies, dragonflies, bees, fish schools) that orbit anchors near
 * the camera with zero per-member CPU work. Everything is capped per quality preset and only exists near the camera.
 */
export class Critters {
  readonly root = new THREE.Group();
  readonly sim: CritterSim;
  /** Positional critter sounds for the audio system (squeak, bark, buzz, …). */
  onSound: ((s: CritterSound) => void) | null = null;
  private species: SpeciesMesh[] = [];
  private blobs!: THREE.InstancedMesh;
  private swarms: SwarmMesh[] = [];
  private hab: Habitats;
  private swarmClock = 0;
  private buzzClock = 0;
  private uWater = uniform(0);
  /** wall-clock seconds (the scare timestamps use the same clock) */
  private uNow = uniform(0);
  private uScare = uniform(new THREE.Vector4(0, -999, 0, -99));
  private fwd = new THREE.Vector3();
  private quality: CritterQuality = 'high';

  constructor(def: MapDef, perches: PerchIn[], seed = def.seed) {
    this.root.name = 'critters';
    this.hab = buildHabitats(def, perches);
    this.sim = new CritterSim(this.hab, seed);
    for (const d of SPECIES_DEFS) {
      const n = d.cap.ultra;
      const geo = critterGeometry(d.name).clone();
      const crit = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      crit.setUsage(THREE.DynamicDrawUsage);
      const mesh = new THREE.InstancedMesh(geo, undefined, n);
      const mats = new THREE.InstancedInterleavedBuffer(mesh.instanceMatrix.array as Float32Array, 16, 1);
      mats.setUsage(THREE.DynamicDrawUsage);
      const mat = animated(d.name, d.mode === 'water', crit, mats);
      staticVelocity(mat);
      mesh.material = mat;
      mesh.name = `critter:${d.name}`;
      mesh.count = 0;
      mesh.frustumCulled = false; // per-agent culling happens on the CPU
      mesh.castShadow = false; // draw calls are the cost here (× shadow cascades); critters are small
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const tinted = !!TINTS[d.name];
      if (tinted) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      this.species.push({ def: d, mesh, crit, mats, tinted });
      this.root.add(mesh);
    }
    for (const d of SWARM_DEFS) this.swarms.push(this.swarmMesh(d));
    const maxBlobs = SPECIES_DEFS.filter((d) => d.mode === 'ground').reduce((a, d) => a + d.cap.ultra, 0);
    this.blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blobMaterial(), maxBlobs);
    this.blobs.name = 'critter:blobs';
    this.blobs.count = 0;
    this.blobs.frustumCulled = false;
    this.blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.blobs);
  }

  setQuality(q: CritterQuality) { this.quality = q; this.sim.quality = q; }

  /** Shots and explosions scare wildlife (shooter + impact points; blast centre). */
  onEvent(e: MatchEvent) {
    if (e.type === 'shot') {
      const from = e.data.from as Vec3 | undefined, to = e.data.to as Vec3 | undefined;
      if (e.data.weapon === 'fists' || !from) return;
      this.sim.noise('shot', to ? [from, to] : [from]);
      this.scare(to ?? from, 0.6);
    } else if (e.type === 'explosion') {
      const pos = e.data.pos as Vec3 | undefined;
      if (!pos) return;
      this.sim.noise('explosion', [pos]);
      this.scare(pos, 1.5);
    }
  }

  private scare(p: Vec3, k: number) { this.uScare.value.set(p.x, p.y, p.z, performance.now() / 1000 - (1 - k)); }

  stats() {
    const out: Record<string, number> = {};
    for (const s of this.species) out[s.def.name] = s.mesh.count;
    for (const s of this.swarms) out[s.def.name] = s.mesh.count;
    return out;
  }

  /** Debug: positions of live agents of a species (screenshots aim at them). */
  where(name: string): V3[] { return this.sim.agents.filter((a) => a.def.name === name && a.show > 0.5).map((a) => ({ x: a.x, y: a.y, z: a.z })); }

  update(dt: number, camera: THREE.PerspectiveCamera, players: V3[], waterY: number) {
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pm);
    const visible = (x: number, y: number, z: number, r: number) => _fr.intersectsSphere(_sp.set(_p.set(x, y, z), r));
    camera.getWorldDirection(this.fwd);
    const cam = camera.position;
    this.uWater.value = waterY;
    this.uNow.value = performance.now() / 1000;
    this.sim.update(dt, { cam, fwd: this.fwd, players, visible, waterY });
    for (const s of this.sim.sounds) this.onSound?.(s);
    this.sim.sounds.length = 0;
    this.writeAgents(visible);
    this.swarmClock -= dt;
    if (this.swarmClock <= 0) { this.swarmClock = 0.3; this.placeSwarms(cam, visible); }
    // flies / bees buzz near the camera
    this.buzzClock -= dt;
    if (this.buzzClock <= 0) {
      this.buzzClock = 1.4;
      for (const s of this.swarms) {
        if (!s.def.sound || !s.mesh.count) continue;
        const arr = s.a.array as Float32Array;
        if (Math.hypot(arr[0] - cam.x, arr[1] - cam.y, arr[2] - cam.z) < 7) { this.onSound?.({ kind: s.def.sound, x: arr[0], y: arr[1], z: arr[2] }); break; }
      }
    }
  }

  private writeAgents(visible: (x: number, y: number, z: number, r: number) => boolean) {
    let nb = 0;
    for (const s of this.species) {
      let n = 0;
      const crit = s.crit.array as Float32Array;
      for (const a of this.sim.agents) {
        if (a.def !== s.def || a.show < 0.02 || !visible(a.x, a.y, a.z, 0.5 + a.def.size)) continue;
        this.matrixOf(a, _m);
        s.mesh.setMatrixAt(n, _m);
        crit[n * 3] = a.phase; crit[n * 3 + 1] = a.gait; crit[n * 3 + 2] = a.pose;
        if (s.tinted) { const t = TINTS[s.def.name]; s.mesh.setColorAt(n, _c.setHex(t[a.id % t.length])); }
        if (s.def.mode === 'ground' && a.st !== 'fly' && a.st !== 'circle' && a.st !== 'dive' && nb < this.blobs.instanceMatrix.count) {
          const r = a.def.size * (a.def.scale ?? 1) * 1.1 * a.show;
          _m.makeScale(r * 0.75, 1, r).premultiply(_m2.makeRotationY(a.yaw)).setPosition(a.x, a.y + 0.012, a.z);
          this.blobs.setMatrixAt(nb++, _m);
        }
        n++;
      }
      s.mesh.count = n;
      s.mesh.visible = n > 0; // no draw call for an empty species
      if (n) {
        s.mesh.instanceMatrix.needsUpdate = true;
        s.mats.needsUpdate = true;
        s.crit.needsUpdate = true;
        if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true;
      }
    }
    this.blobs.count = nb;
    this.blobs.visible = nb > 0;
    if (nb) this.blobs.instanceMatrix.needsUpdate = true;
  }

  private matrixOf(a: Agent, out: THREE.Matrix4) {
    const sc = Math.max(0.001, a.show) * (a.def.scale ?? 1);
    _s.set(sc, sc, sc);
    _p.set(a.x, a.y, a.z);
    const w = a.home.wall;
    if (w) {
      // climbers: belly on the wall (local up = wall normal), heading in the wall plane
      _y.set(w.nx, 0, w.nz);
      const ch = Math.cos(a.head), sh = Math.sin(a.head);
      _z.set(w.ux * ch, sh, w.uz * ch).negate(); // local +Z = backward
      _x.crossVectors(_y, _z).normalize();
      out.makeBasis(_x, _y, _z);
      out.scale(_s);
      out.setPosition(_p);
      return;
    }
    const pitch = a.st === 'dive' ? -1.1 : a.st === 'jump' ? (0.5 - a.pose) * 1.6 : 0;
    _q.setFromEuler(_e.set(pitch, a.yaw, 0, 'YXZ'));
    out.compose(_p, _q, _s);
  }

  // ------------------------------------------------------------------ swarms

  private swarmMesh(d: SwarmDef): SwarmMesh {
    const n = d.cap.ultra || 1;
    const geo = critterGeometry(d.name).clone();
    // sw = anchor xyz + seed; sw2 = orbit rx, ry, speed, beat
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4), b = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage); b.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
    m.name = `swarm:${d.name}`;
    const now = this.uNow;
    const A = instancedDynamicBufferAttribute(a, 'vec4') as unknown as THREE.Node<'vec4'>, B = instancedDynamicBufferAttribute(b, 'vec4') as unknown as THREE.Node<'vec4'>;
    const seed = A.w, t = now.mul(B.z).add(seed.mul(17.3));
    // wandering lissajous orbit around the anchor
    let off: THREE.Node<'vec3'> = vec3(sin(t).mul(B.x).add(sin(t.mul(2.3).add(seed)).mul(B.x.mul(0.35))), sin(t.mul(1.7).add(seed.mul(3.1))).mul(B.y), cos(t.mul(1.13)).mul(B.x).add(cos(t.mul(2.9).add(seed.mul(2))).mul(B.x.mul(0.3))));
    if (d.name === 'fly') off = off.add(vec3(sin(now.mul(23).add(seed.mul(9))), cos(now.mul(19).add(seed.mul(5))), sin(now.mul(29).add(seed.mul(7)))).mul(0.06));
    if (d.name === 'dragonfly') {
      // hover, then dart: position snaps between orbit samples with a quick ease
      const k = now.mul(0.7).add(seed.mul(5)).fract();
      off = off.mul(float(1).sub(exp(k.mul(-14)).mul(0.6)));
    }
    // flee: pushed away from a recent shot / blast
    const S = this.uScare;
    const anchor = vec3(A.x, A.y.add(d.water ? this.uWater : 0), A.z);
    const rel = anchor.add(off).sub(S.xyz);
    const age = now.sub(S.w).max(0);
    const push = exp(age.mul(-1.2)).mul(max(float(1).sub(rel.length().div(9)), 0)).mul(3);
    const pos = anchor.add(off).add(rel.normalize().mul(push));
    // heading: along the orbit's tangent (approximate), wings beat
    const vel = vec3(cos(t).mul(B.x), 0, sin(t.mul(1.13)).mul(B.x).negate());
    const yaw = vel.x.negate().atan(vel.z.negate()) as F;
    const p = positionGeometry;
    const limb = attribute<'vec2'>('limb', 'vec2');
    const wing = isK(limb.x, 3), tail = isK(limb.x, 4);
    const beat = d.beat > 0 ? sin(now.mul(d.beat * 6.283).add(seed.mul(11))) : sin(now.mul(140).add(seed.mul(11)));
    const local = vec3(p.x.mul(mix(float(1), beat.mul(0.5).add(0.6), wing)), p.y.add(beat.mul(limb.y).mul(abs(p.x)).mul(wing).mul(d.beat > 0 ? 1 : 0.2)), p.z)
      .add(vec3(sin(now.mul(9).add(seed)).mul(limb.y).mul(tail), 0, 0));
    const cy = cos(yaw), sy = sin(yaw);
    m.positionNode = vec3(local.x.mul(cy).add(local.z.mul(sy)), local.y, local.z.mul(cy).sub(local.x.mul(sy))).add(pos);
    if (d.water) underwater(m, 0.6);
    staticVelocity(m);
    const mesh = new THREE.InstancedMesh(geo, m, n);
    mesh.name = `swarm:${d.name}`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    if (TINTS[d.name]) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      for (let i = 0; i < n; i++) mesh.setColorAt(i, _c.setHex(TINTS[d.name][i % TINTS[d.name].length]));
    }
    this.root.add(mesh);
    return { def: d, mesh, a, b };
  }

  /** Fill each swarm's members from the visible anchors nearest the camera (identity instance matrices). */
  private placeSwarms(cam: THREE.Vector3, visible: (x: number, y: number, z: number, r: number) => boolean) {
    for (const s of this.swarms) {
      const d = s.def, cap = d.cap[this.quality];
      const list = d.habitat.flatMap((h) => this.hab[h]);
      const near = list
        .map((p, i) => ({ p, i, d: (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 }))
        .filter((c) => c.d < d.spawnR * d.spawnR && (d.water ? !this.hab.land(c.p.x, c.p.z) || c.p.water : true) && visible(c.p.x, c.p.y + (d.water ? this.uWater.value : 0), c.p.z, d.rx + 1))
        .sort((a, b) => a.d - b.d);
      const A = s.a.array as Float32Array, B = s.b.array as Float32Array;
      let n = 0;
      for (const c of near) {
        for (let k = 0; k < d.perAnchor && n < cap; k++, n++) {
          const seed = ((c.i * 31 + k * 7) % 97) + k * 0.37;
          A[n * 4] = c.p.x; A[n * 4 + 1] = d.water ? c.p.y * 0.5 - 0.1 : c.p.y; A[n * 4 + 2] = c.p.z; A[n * 4 + 3] = seed;
          B[n * 4] = d.rx * (0.6 + ((k * 0.37) % 0.8)); B[n * 4 + 1] = d.ry; B[n * 4 + 2] = d.speed * (0.8 + ((k * 0.13) % 0.4)) * (k % 2 ? 1 : -1); B[n * 4 + 3] = d.beat;
        }
        if (n >= cap) break;
      }
      if (s.mesh.count === 0 && n > 0) for (let i = 0; i < s.mesh.instanceMatrix.count; i++) s.mesh.setMatrixAt(i, _m.identity());
      s.mesh.count = n;
      s.mesh.visible = n > 0;
      s.a.needsUpdate = true; s.b.needsUpdate = true;
      if (n) s.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

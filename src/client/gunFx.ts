import * as THREE from 'three/webgpu';
import type { MatchEvent, Projectile, Vec3, WeaponKind } from '../sim/types';
import { Casings } from './world/casings';
import type { Particles } from './world/particles';

/**
 * Gun and explosive feel, all event-driven and pooled (no per-shot allocations or shader compiles):
 * tracers that leave the muzzle and travel, muzzle flash light, smoke puffs, ejected shell casings,
 * armour sparks on player hits, live projectiles (rockets with a smoke trail, grenades, charges) and
 * bigger explosions with a light flash. Particles share the piece-damage pools (3 draws total).
 */

/** Where a shooter's gun is: muzzle / ejection port in world space, or null if unknown (falls back to the eye). */
export type GunPointFn = (playerId: number, which: 'muzzle' | 'eject', out: THREE.Vector3) => THREE.Vector3 | null;

const UNLIT_BOOST = 2.6;
const R = Math.random;
const rr = (a: number, b: number) => a + (b - a) * R();
const TRACER_POOL = 64;
const TRACER_SPEED = 420; // m/s, visual
const TRACER_LEN = 5;
const BRASS = 0xc9a03c;
const SHELL_RED = 0xa32a1e;
/** Smoke per shot (puffs) and how hard each gun's flash lights the scene. */
const MUZZLE: Record<WeaponKind, { smoke: number; light: number; sparks: number }> = {
  fists: { smoke: 0, light: 0, sparks: 0 }, pistol: { smoke: 2, light: 1, sparks: 3 }, smg: { smoke: 1, light: 0.8, sparks: 2 },
  shotgun: { smoke: 5, light: 1.6, sparks: 8 }, rifle: { smoke: 2, light: 1.2, sparks: 4 }, rocket: { smoke: 14, light: 2.2, sparks: 14 },
};

type Tracer = { mesh: THREE.Mesh; mat: THREE.MeshBasicNodeMaterial; from: THREE.Vector3; dir: THREE.Vector3; len: number; born: number; live: boolean };
type ProjView = { obj: THREE.Object3D; kind: Projectile['kind']; last: THREE.Vector3; seen: number };

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

export class GunFx {
  readonly root = new THREE.Group();
  /** Spent cases that stay on the ground (ring buffer, capped per quality: set `casings.limit`). */
  readonly casings = new Casings();
  private tracers: Tracer[] = [];
  private tracerGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  private muzzleLight = new THREE.PointLight(0xffb060, 0, 9, 2);
  private muzzleUntil = 0;
  private muzzlePeak = 0;
  private boomLight = new THREE.PointLight(0xff9a40, 0, 28, 2);
  private boomAt = 0;
  private boomPeak = 0;
  private projs = new Map<number, ProjView>();
  private rocketGeo: THREE.BufferGeometry;
  private rocketMat = new THREE.MeshStandardNodeMaterial({ color: 0x55603a, roughness: 0.6, metalness: 0.3 });
  private flameMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xffb050).multiplyScalar(4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  private flameGeo = new THREE.ConeGeometry(0.06, 0.45, 8).rotateX(Math.PI / 2).translate(0, 0, 0.42);
  private grenadeGeo = new THREE.SphereGeometry(0.07, 10, 8);
  private grenadeMat = new THREE.MeshStandardNodeMaterial({ color: 0x3d4a2a, roughness: 0.7, metalness: 0.2 });
  private chargeGeo = new THREE.BoxGeometry(0.22, 0.12, 0.16);
  private chargeMat = new THREE.MeshStandardNodeMaterial({ color: 0x2b2d30, roughness: 0.6 });
  private ledMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xff2020).multiplyScalar(4) });
  private ledGeo = new THREE.SphereGeometry(0.02, 6, 4);
  private last = performance.now();
  private warmGroup: THREE.Group | null = null;
  private warmFrames = 0;

  constructor(private particles: Particles, private gunPoint: GunPointFn) {
    this.root.name = 'gunFx';
    this.root.add(this.casings.mesh);
    for (let i = 0; i < TRACER_POOL; i++) {
      const mat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xfff2a8).multiplyScalar(UNLIT_BOOST), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(this.tracerGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.tracers.push({ mesh, mat, from: new THREE.Vector3(), dir: new THREE.Vector3(), len: 0, born: 0, live: false });
    }
    // Two fixed lights (intensity 0 at rest): adding/removing lights would recompile every material.
    this.muzzleLight.castShadow = false;
    this.boomLight.castShadow = false;
    this.root.add(this.muzzleLight, this.boomLight);
    const body = new THREE.CylinderGeometry(0.034, 0.034, 0.5, 10).rotateX(Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.036, 0.16, 10).rotateX(-Math.PI / 2).translate(0, 0, -0.33);
    const fins = new THREE.BoxGeometry(0.16, 0.012, 0.08).translate(0, 0, 0.22);
    const fins2 = fins.clone().rotateZ(Math.PI / 2);
    this.rocketGeo = mergeAll([body, nose, fins, fins2]);
  }

  /**
   * Draw every fx material once, out of sight, so the first shot/rocket/explosion of the match doesn't
   * stall a frame compiling shaders (pools that start hidden are otherwise compiled on first use).
   */
  warmUp(extra: THREE.Material[] = []) {
    const g = new THREE.Group();
    const y = -40;
    const mats: THREE.Material[] = [this.casings.mesh.material as THREE.Material, this.tracers[0].mat, this.rocketMat, this.flameMat, this.grenadeMat, this.chargeMat, this.ledMat, ...extra];
    mats.forEach((m, i) => {
      const mesh = new THREE.Mesh(this.grenadeGeo, m);
      mesh.position.set(i * 0.2, y, 0);
      mesh.frustumCulled = false;
      g.add(mesh);
    });
    this.root.add(g);
    this.warmGroup = g;
    this.warmFrames = 0;
    const { dust, sparks, debris, flames } = this.particles;
    flames.spawn(0, y, 0, 0, 0, 0, 0.5, 0.1, 0.1, 1, 1, 1, 0.01, 0, 0);
    dust.spawn(0, y, 0, 0, 0, 0, 0.5, 0.1, 0.1, 1, 1, 1, 0.01, 0, 0);
    sparks.spawn(0, y, 0, 0, 0, 0, 0.5, 0.1, 0.1, 1, 1, 1, 0.01, 0, 0);
    debris.spawn(0, y, 0, 0, 0, 0, 0.01, 0.01, 0.01, BRASS, 0.5, y - 1);
    this.muzzleLight.intensity = 0.001;
  }

  /** Feed every snapshot's events (`myId` gets the closer, brighter variants). */
  onEvent(e: MatchEvent, myId: number) {
    if (e.data.echo) return; // already shown when predicted (shotPredict.ts)
    if (e.type === 'shot') this.onShot(e.data, myId);
    else if (e.type === 'hit') this.onHit(e.data);
    else if (e.type === 'explosion') this.onExplosion(e.data);
  }

  private onShot(d: Record<string, unknown>, myId: number) {
    const by = d.by as number, weapon = (d.weapon as WeaponKind) ?? 'pistol';
    if (weapon === 'fists') return;
    const from = d.from as Vec3, to = d.to as Vec3;
    const muzzle = this.gunPoint(by, 'muzzle', _a) ?? _a.set(from.x, from.y, from.z);
    const fx = MUZZLE[weapon];
    const now = performance.now();
    // Flash light at the muzzle (the most recent shot wins the one light).
    this.muzzleLight.position.copy(muzzle);
    this.muzzlePeak = 6 * fx.light * (by === myId ? 1 : 1.3);
    this.muzzleUntil = now + (weapon === 'rocket' ? 110 : 55);
    // Aim direction (for smoke/sparks going out of the barrel).
    const dir = _b.set(to.x - from.x, to.y - from.y, to.z - from.z);
    if (weapon === 'rocket' || dir.lengthSq() < 1e-6) {
      const yawPitch = this.gunPoint(by, 'eject', _c);
      if (yawPitch) dir.copy(muzzle).sub(_c); else dir.set(0, 0, -1);
    }
    dir.normalize();
    const { dust, sparks, debris } = this.particles;
    for (let i = 0; i < fx.sparks; i++) {
      const s = rr(4, 12);
      sparks.spawn(muzzle.x, muzzle.y, muzzle.z, dir.x * s + rr(-1.5, 1.5), dir.y * s + rr(-1.5, 1.5), dir.z * s + rr(-1.5, 1.5),
        rr(0.04, 0.1), rr(0.03, 0.06), 0.01, 1, rr(0.6, 0.8), 0.3, 1, 2, 4);
    }
    for (let i = 0; i < fx.smoke; i++) {
      const s = rr(0.6, 2.2) * (weapon === 'rocket' ? 0.6 : 1);
      dust.spawn(muzzle.x + dir.x * 0.08, muzzle.y + dir.y * 0.08, muzzle.z + dir.z * 0.08, dir.x * s + rr(-0.2, 0.2), dir.y * s + rr(0, 0.35), dir.z * s + rr(-0.2, 0.2),
        rr(0.6, 1.3), rr(0.06, 0.12), rr(0.35, 0.7), 0.72, 0.72, 0.7, 0.32, -0.25, 2.5);
    }
    const eject = this.gunPoint(by, 'eject', _c);
    if (weapon === 'rocket') {
      // Back-blast out of the rear of the tube.
      if (eject) for (let i = 0; i < 16; i++) {
        const s = rr(2, 7);
        dust.spawn(eject.x, eject.y, eject.z, -dir.x * s + rr(-1, 1), -dir.y * s + rr(-0.5, 1), -dir.z * s + rr(-1, 1), rr(0.8, 1.6), 0.15, rr(0.8, 1.4), 0.8, 0.78, 0.74, 0.45, -0.2, 2);
      }
    } else if (eject) {
      // Spent case: out to the right and up, tumbling, bouncing on the ground near the shooter's feet.
      const rx = -dir.z, rz = dir.x; // right of the aim, flat
      const rl = Math.hypot(rx, rz) || 1;
      const s = rr(1.6, 2.6);
      const shotgun = weapon === 'shotgun';
      this.casings.spawn(eject.x, eject.y, eject.z, (rx / rl) * s + rr(-0.3, 0.3) - dir.x * 0.4, rr(1.6, 2.6), (rz / rl) * s + rr(-0.3, 0.3) - dir.z * 0.4,
        shotgun ? 0.06 : weapon === 'rifle' ? 0.045 : 0.028, shotgun ? 0.011 : 0.0055, shotgun ? SHELL_RED : BRASS, from.y - 1.6);
    }
    if (weapon === 'rocket') return;
    this.tracer(muzzle, to, by === myId);
    for (const p of (d.tos as Vec3[] | undefined) ?? []) this.tracer(muzzle, p, by === myId, 0.5);
  }

  private tracer(from: THREE.Vector3, to: Vec3, mine: boolean, k = 1) {
    const t = this.tracers.find((x) => !x.live) ?? this.tracers.reduce((a, b) => (a.born < b.born ? a : b));
    t.from.copy(from);
    t.dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    t.len = t.dir.length();
    if (t.len < 0.3) return;
    t.dir.divideScalar(t.len);
    t.born = performance.now();
    t.live = true;
    t.mesh.visible = true;
    t.mat.color.setHex(mine ? 0xfff2a8 : 0xffb070).multiplyScalar(UNLIT_BOOST * k);
    t.mesh.scale.set(0.022, 0.022, 1);
  }

  private onHit(d: Record<string, unknown>) {
    const p = d.pos as Vec3 | undefined;
    if (!p || d.weapon === 'rocket') return;
    // Armour spark + a little grey puff: hits read without any gore.
    const head = d.part === 'head';
    const { sparks, dust } = this.particles;
    for (let i = 0; i < (head ? 14 : 8); i++) {
      const a = R() * Math.PI * 2, s = rr(2, 6);
      sparks.spawn(p.x, p.y, p.z, Math.cos(a) * s, rr(0.5, 4), Math.sin(a) * s, rr(0.12, 0.3), rr(0.04, 0.07), 0.01, 1, head ? 0.45 : 0.75, 0.3, 1, 9, 1.5);
    }
    sparks.spawn(p.x, p.y, p.z, 0, 0, 0, 0.07, head ? 0.4 : 0.28, 0.1, 1, 0.85, 0.6, 1, 0, 0);
    for (let i = 0; i < 3; i++) dust.spawn(p.x, p.y, p.z, rr(-0.4, 0.4), rr(0, 0.5), rr(-0.4, 0.4), rr(0.4, 0.7), 0.06, rr(0.25, 0.4), 0.6, 0.6, 0.6, 0.45, -0.2, 2);
  }

  private onExplosion(d: Record<string, unknown>) {
    const p = d.pos as Vec3 | undefined;
    if (!p) return;
    const rocket = d.kind === 'rocket';
    const big = rocket ? 1.25 : d.kind === 'barrel' ? 1.35 : d.kind === 'propane' ? 1.2 : d.kind === 'charge' ? 1.1 : 1;
    this.boomLight.position.set(p.x, p.y + 0.5, p.z);
    this.boomPeak = 260 * big;
    this.boomAt = performance.now();
    const { sparks, dust, debris } = this.particles;
    for (let i = 0; i < 46 * big; i++) {
      const a = R() * Math.PI * 2, u = rr(-0.2, 1), s = rr(5, 16) * big;
      const c = Math.sqrt(1 - u * u);
      sparks.spawn(p.x, p.y, p.z, Math.cos(a) * c * s, u * s + 2, Math.sin(a) * c * s, rr(0.3, 0.9), rr(0.06, 0.12), 0.02, 1, rr(0.5, 0.75), 0.2, 1, 9, 1.2);
    }
    // Fireball core (additive, fast fade) then a rolling smoke column.
    for (let i = 0; i < 14; i++) {
      const a = R() * Math.PI * 2, s = rr(1, 4) * big;
      sparks.spawn(p.x, p.y + 0.3, p.z, Math.cos(a) * s, rr(0.5, 3), Math.sin(a) * s, rr(0.25, 0.45), rr(0.8, 1.4) * big, rr(1.6, 2.4) * big, 1, rr(0.45, 0.6), 0.15, 0.9, -1, 3);
    }
    for (let i = 0; i < 26 * big; i++) {
      const a = R() * Math.PI * 2, s = rr(0.8, 3.5) * big;
      dust.spawn(p.x + rr(-0.5, 0.5), p.y + rr(0, 0.6), p.z + rr(-0.5, 0.5), Math.cos(a) * s, rr(0.8, 3.2), Math.sin(a) * s,
        rr(2.2, 4), rr(0.6, 1.0) * big, rr(2.2, 3.4) * big, 0.3, 0.29, 0.28, 0.75, -0.6, 1.1);
    }
    for (let i = 0; i < 10; i++) {
      const a = R() * Math.PI * 2, s = rr(3, 8);
      debris.spawn(p.x, p.y + 0.2, p.z, Math.cos(a) * s, rr(3, 8), Math.sin(a) * s, rr(0.04, 0.09), rr(0.04, 0.09), rr(0.04, 0.09), 0x5a4a38, rr(1.2, 2), p.y - 4);
    }
  }

  /** Live projectiles from the latest snapshot (drawn extrapolated along their velocity). */
  syncProjectiles(list: Projectile[]) {
    const now = performance.now();
    for (const p of list) {
      let v = this.projs.get(p.id);
      if (!v) {
        v = { obj: this.build(p.kind), kind: p.kind, last: new THREE.Vector3(p.pos.x, p.pos.y, p.pos.z), seen: now };
        v.obj.position.copy(v.last);
        this.root.add(v.obj);
        this.projs.set(p.id, v);
      }
      v.seen = now;
      v.obj.userData.target = p;
    }
    for (const [id, v] of this.projs) if (v.seen !== now) { this.root.remove(v.obj); this.projs.delete(id); }
  }

  private build(kind: Projectile['kind']): THREE.Object3D {
    const g = new THREE.Group();
    if (kind === 'rocket') {
      g.add(new THREE.Mesh(this.rocketGeo, this.rocketMat), new THREE.Mesh(this.flameGeo, this.flameMat));
    } else if (kind === 'grenade') {
      g.add(new THREE.Mesh(this.grenadeGeo, this.grenadeMat));
    } else {
      const led = new THREE.Mesh(this.ledGeo, this.ledMat);
      led.position.set(0.05, 0.07, 0);
      led.name = 'led';
      g.add(new THREE.Mesh(this.chargeGeo, this.chargeMat), led);
    }
    for (const c of g.children) c.castShadow = kind !== 'rocket' || c !== g.children[1];
    return g;
  }

  /** Per frame. `ageSec` = time since the latest snapshot arrived. */
  update(ageSec: number) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.casings.update(dt);
    for (const t of this.tracers) {
      if (!t.live) continue;
      const travelled = ((now - t.born) / 1000) * TRACER_SPEED;
      const head = Math.min(t.len, travelled + TRACER_LEN * 0.3);
      const tail = Math.max(0, head - TRACER_LEN);
      if (tail >= t.len - 0.05 || now - t.born > 400) { t.live = false; t.mesh.visible = false; continue; }
      t.mesh.position.copy(t.from).addScaledVector(t.dir, tail);
      t.mesh.lookAt(_d.copy(t.from).addScaledVector(t.dir, t.len));
      t.mesh.scale.z = Math.max(0.05, head - tail);
      t.mat.opacity = 0.95;
    }
    if (this.warmGroup && ++this.warmFrames > 20) { this.root.remove(this.warmGroup); this.warmGroup = null; }
    const mk = now < this.muzzleUntil ? 1 : 0;
    this.muzzleLight.intensity = this.muzzlePeak * mk;
    const bk = (now - this.boomAt) / 1000;
    this.boomLight.intensity = bk < 0.6 ? this.boomPeak * Math.exp(-bk * 7) : 0;

    const { dust, sparks } = this.particles;
    for (const v of this.projs.values()) {
      const p = v.obj.userData.target as Projectile;
      // Extrapolate from the latest snapshot along the velocity (smooth at 15-30 Hz updates).
      const ex = Math.min(ageSec, 0.12);
      _a.set(p.pos.x + p.vel.x * ex, p.pos.y + p.vel.y * ex, p.pos.z + p.vel.z * ex);
      v.obj.position.lerp(_a, Math.min(1, dt * 25));
      if (v.kind === 'rocket') {
        _b.set(p.vel.x, p.vel.y, p.vel.z);
        if (_b.lengthSq() > 1) v.obj.lookAt(_c.copy(v.obj.position).sub(_b)); // model nose is -Z; lookAt points +Z at target
        // Smoke trail: puffs laid along the path travelled since last frame.
        const step = v.last.distanceTo(v.obj.position);
        const n = Math.min(8, Math.ceil(step / 0.35));
        for (let i = 0; i < n; i++) {
          _c.copy(v.last).lerp(v.obj.position, i / n);
          dust.spawn(_c.x + rr(-0.04, 0.04), _c.y + rr(-0.04, 0.04), _c.z + rr(-0.04, 0.04), rr(-0.2, 0.2), rr(0.1, 0.4), rr(-0.2, 0.2),
            rr(1.2, 2.2), rr(0.12, 0.2), rr(0.7, 1.2), 0.82, 0.8, 0.78, 0.55, -0.15, 1.2);
        }
        sparks.spawn(v.obj.position.x, v.obj.position.y, v.obj.position.z, -_b.x * 0.05, -_b.y * 0.05, -_b.z * 0.05, 0.06, 0.18, 0.05, 1, 0.65, 0.3, 1, 0, 0);
        (v.obj.children[1] as THREE.Mesh).scale.setScalar(0.8 + R() * 0.5);
      } else if (v.kind === 'charge') {
        const led = v.obj.getObjectByName('led');
        if (led) led.visible = Math.floor(now / 250) % 2 === 0;
      }
      v.last.copy(v.obj.position);
    }
  }

  /** Rockets in the air now (for the flight sound). */
  liveRockets(): { id: number; pos: THREE.Vector3 }[] {
    const out: { id: number; pos: THREE.Vector3 }[] = [];
    for (const [id, v] of this.projs) if (v.kind === 'rocket') out.push({ id, pos: v.obj.position });
    return out;
  }
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Small local merge (positions + normals) so the rocket is one draw.
  const parts = geos.map((g) => g.toNonIndexed());
  const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

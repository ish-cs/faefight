/**
 * Client-only death ragdoll: a Verlet particle skeleton (15 points: pelvis, chest, head, shoulders/elbows/hands,
 * hips/knees/ankles) held together by distance constraints, falling onto one floor plane. Pure maths (no three.js),
 * never touches the sim: ragdoll.ts poses the skinned rig from these points.
 *
 * Torso: the six torso points are braced pairwise (rigid). Limbs: fixed-length segments; a range constraint per limb
 * stops elbows/knees folding flat, and a hinge rule keeps knees bending forward. Contacts are inelastic with friction.
 */

export const RP = {
  pelvis: 0, chest: 1, head: 2,
  shL: 3, elL: 4, haL: 5, shR: 6, elR: 7, haR: 8,
  hipL: 9, knL: 10, anL: 11, hipR: 12, knR: 13, anR: 14,
} as const;
export const RP_COUNT = 15;

export const RAGDOLL = {
  gravity: 9.81,
  /** fixed step (s) and the most steps one frame may take (a long frame just slows the fall) */
  step: 1 / 60,
  maxSteps: 4,
  iterations: 8,
  /** per-step velocity kept (air drag) */
  damping: 0.995,
  /** horizontal velocity removed per step while touching the floor */
  friction: 0.35,
  /** asleep once every point is slower than this (m/s) for `sleepHold` s, or at `maxAge` s regardless */
  sleepSpeed: 0.08,
  sleepHold: 0.35,
  maxAge: 4.5,
  /** a landing this hard (m/s) is a thud; at most one per body per thudGap s */
  thudSpeed: 1.2,
  thudGap: 0.3,
};

/** Collision radius per point (m). */
const RADIUS = [0.1, 0.1, 0.11, 0.1, 0.05, 0.05, 0.1, 0.05, 0.05, 0.1, 0.07, 0.05, 0.1, 0.07, 0.05];
const TORSO = [RP.pelvis, RP.chest, RP.shL, RP.shR, RP.hipL, RP.hipR];

type Link = { a: number; b: number; min: number; max: number };

export class RagdollSim {
  readonly pos = new Float32Array(RP_COUNT * 3);
  private prev = new Float32Array(RP_COUNT * 3);
  private links: Link[] = [];
  /** Torso points in the torso's own frame at the start (it is moved as one rigid body). */
  private torsoRest = new Float32Array(TORSO.length * 3);
  /** Hardest landing (m/s into the floor) since the last takeImpact(), and when the last one was reported. */
  private impact = 0;
  private impactAt = -1e9;
  /** Sign that turns cross(up, side) into the body's forward (set from the facing at start). */
  private fwdSign = 1;
  age = 0;
  asleep = false;
  private still = 0;
  private acc = 0;

  /**
   * `points`: RP_COUNT world positions (x, y, z each) in the pose at death; `fwd`: the body's facing (x, z);
   * `floorY`: the plane it lands on.
   */
  constructor(points: ArrayLike<number>, fwd: { x: number; z: number }, readonly floorY: number) {
    if (points.length < RP_COUNT * 3) throw new Error(`[ragdoll] need ${RP_COUNT * 3} coordinates, got ${points.length}`);
    for (let i = 0; i < RP_COUNT * 3; i++) this.pos[i] = this.prev[i] = points[i];
    const fixed = (a: number, b: number) => { const d = this.dist(a, b); this.links.push({ a, b, min: d, max: d }); };
    const range = (a: number, b: number, lo: number, hi: number) => { const d = this.dist(a, b); this.links.push({ a, b, min: d * lo, max: d * hi }); };
    const reach = (a: number, m: number, b: number, lo: number) => { const L = this.dist(a, m) + this.dist(m, b); this.links.push({ a, b, min: L * lo, max: L }); };
    this.torsoFrame(_t);
    for (let j = 0; j < TORSO.length; j++) {
      const o = TORSO[j] * 3;
      const rx = this.pos[o] - _t[9], ry = this.pos[o + 1] - _t[10], rz = this.pos[o + 2] - _t[11];
      for (let a = 0; a < 3; a++) this.torsoRest[j * 3 + a] = rx * _t[a * 3] + ry * _t[a * 3 + 1] + rz * _t[a * 3 + 2];
    }
    fixed(RP.chest, RP.head);
    range(RP.shL, RP.head, 0.82, 1.15);
    range(RP.shR, RP.head, 0.82, 1.15);
    for (const [s, e, h] of [[RP.shL, RP.elL, RP.haL], [RP.shR, RP.elR, RP.haR]]) { fixed(s, e); fixed(e, h); reach(s, e, h, 0.35); }
    for (const [h, k, a] of [[RP.hipL, RP.knL, RP.anL], [RP.hipR, RP.knR, RP.anR]]) { fixed(h, k); fixed(k, a); reach(h, k, a, 0.55); }
    const f = this.forward(_f);
    this.fwdSign = f[0] * fwd.x + f[2] * fwd.z >= 0 ? 1 : -1;
  }

  /** Add velocity (m/s) to point `i`. */
  kick(i: number, vx: number, vy: number, vz: number) {
    const dt = RAGDOLL.step;
    this.prev[i * 3] -= vx * dt; this.prev[i * 3 + 1] -= vy * dt; this.prev[i * 3 + 2] -= vz * dt;
  }

  /** Velocity of point `i` (m/s), from the last step. */
  velocity(i: number, out: number[] = [0, 0, 0]) {
    for (let k = 0; k < 3; k++) out[k] = (this.pos[i * 3 + k] - this.prev[i * 3 + k]) / RAGDOLL.step;
    return out;
  }

  /** Advance by a frame's `dt` in fixed steps. Returns false once asleep (nothing moves any more). */
  update(dt: number): boolean {
    if (this.asleep) return false;
    this.acc = Math.min(this.acc + dt, RAGDOLL.step * RAGDOLL.maxSteps);
    while (this.acc >= RAGDOLL.step && !this.asleep) { this.acc -= RAGDOLL.step; this.tick(); }
    return !this.asleep;
  }

  private tick() {
    const dt = RAGDOLL.step, p = this.pos, q = this.prev, g = RAGDOLL.gravity * dt * dt;
    let vmax = 0;
    for (let i = 0; i < RP_COUNT; i++) {
      const o = i * 3;
      for (let k = 0; k < 3; k++) {
        const x = p[o + k], v = (x - q[o + k]) * RAGDOLL.damping;
        q[o + k] = x;
        p[o + k] = x + v - (k === 1 ? g : 0);
      }
    }
    for (let it = 0; it < RAGDOLL.iterations; it++) {
      for (const l of this.links) this.solve(l);
      this.kneeHinge(RP.hipL, RP.knL, RP.anL);
      this.kneeHinge(RP.hipR, RP.knR, RP.anR);
      this.rigidTorso();
      this.floor();
    }
    for (let i = 0; i < RP_COUNT; i++) {
      const o = i * 3;
      const v = Math.hypot(p[o] - q[o], p[o + 1] - q[o + 1], p[o + 2] - q[o + 2]) / dt;
      if (v > vmax) vmax = v;
    }
    this.age += dt;
    this.still = vmax < RAGDOLL.sleepSpeed ? this.still + dt : 0;
    if (this.still >= RAGDOLL.sleepHold || this.age >= RAGDOLL.maxAge) this.asleep = true;
  }

  private solve(l: Link) {
    const p = this.pos, a = l.a * 3, b = l.b * 3;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return;
    const t = d < l.min ? l.min : d > l.max ? l.max : d;
    if (t === d) return;
    const k = (d - t) / d * 0.5;
    p[a] += dx * k; p[a + 1] += dy * k; p[a + 2] += dz * k;
    p[b] -= dx * k; p[b + 1] -= dy * k; p[b + 2] -= dz * k;
  }

  /** Shape matching: put the torso points back in their start shape, at the current torso frame and centroid. */
  private rigidTorso() {
    const t = this.torsoFrame(_t), p = this.pos, r = this.torsoRest;
    for (let j = 0; j < TORSO.length; j++) {
      const o = TORSO[j] * 3, lx = r[j * 3], ly = r[j * 3 + 1], lz = r[j * 3 + 2];
      for (let c = 0; c < 3; c++) p[o + c] = t[9 + c] + lx * t[c] + ly * t[3 + c] + lz * t[6 + c];
    }
  }

  /**
   * Torso frame into `out`: x (body left: shoulders + hips, ⊥ y), y (pelvis → chest), z = x × y, each 3 floats, then
   * the torso centroid (out[9..11]). Ragdoll.ts derives the body bone's rotation from the same frame.
   */
  torsoFrame(out: number[]) {
    const p = this.pos, P = (i: number, k: number) => p[i * 3 + k];
    let yx = P(RP.chest, 0) - P(RP.pelvis, 0), yy = P(RP.chest, 1) - P(RP.pelvis, 1), yz = P(RP.chest, 2) - P(RP.pelvis, 2);
    const yl = Math.hypot(yx, yy, yz) || 1;
    yx /= yl; yy /= yl; yz /= yl;
    let xx = P(RP.shL, 0) - P(RP.shR, 0) + P(RP.hipL, 0) - P(RP.hipR, 0);
    let xy = P(RP.shL, 1) - P(RP.shR, 1) + P(RP.hipL, 1) - P(RP.hipR, 1);
    let xz = P(RP.shL, 2) - P(RP.shR, 2) + P(RP.hipL, 2) - P(RP.hipR, 2);
    const d = xx * yx + xy * yy + xz * yz;
    xx -= d * yx; xy -= d * yy; xz -= d * yz;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    out[0] = xx; out[1] = xy; out[2] = xz;
    out[3] = yx; out[4] = yy; out[5] = yz;
    out[6] = xy * yz - xz * yy; out[7] = xz * yx - xx * yz; out[8] = xx * yy - xy * yx;
    let cx = 0, cy = 0, cz = 0;
    for (const i of TORSO) { cx += P(i, 0); cy += P(i, 1); cz += P(i, 2); }
    out[9] = cx / TORSO.length; out[10] = cy / TORSO.length; out[11] = cz / TORSO.length;
    return out;
  }

  /** Knees only bend forward: push a knee that sits behind its hip→ankle line back in front of it. */
  private kneeHinge(h: number, k: number, a: number) {
    const p = this.pos, f = this.forward(_f);
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (fl < 1e-6) return;
    const s = this.fwdSign / fl;
    let behind = 0;
    for (let c = 0; c < 3; c++) behind += (p[k * 3 + c] - (p[h * 3 + c] + p[a * 3 + c]) * 0.5) * f[c] * s;
    const want = 0.015;
    if (behind >= want) return;
    const push = want - behind;
    for (let c = 0; c < 3; c++) {
      const d = f[c] * s * push;
      p[k * 3 + c] += d * 0.66;
      p[h * 3 + c] -= d * 0.17;
      p[a * 3 + c] -= d * 0.17;
    }
  }

  private floor() {
    const p = this.pos, q = this.prev, fr = RAGDOLL.friction;
    for (let i = 0; i < RP_COUNT; i++) {
      const o = i * 3, lo = this.floorY + RADIUS[i];
      if (p[o + 1] >= lo) continue;
      const vy = (q[o + 1] - p[o + 1]) / RAGDOLL.step;
      if (vy > this.impact) this.impact = vy;
      p[o + 1] = lo;
      q[o + 1] = lo; // inelastic: no bounce
      q[o] += (p[o] - q[o]) * fr;
      q[o + 2] += (p[o + 2] - q[o + 2]) * fr;
    }
  }

  /**
   * Speed (m/s) the body hit the floor with since the last call, for a thud: 0 when nothing landed harder than
   * RAGDOLL.thudSpeed, or within RAGDOLL.thudGap s of the last reported one.
   */
  takeImpact(): number {
    const v = this.impact;
    this.impact = 0;
    if (v < RAGDOLL.thudSpeed || this.age - this.impactAt < RAGDOLL.thudGap) return 0;
    this.impactAt = this.age;
    return v;
  }

  /** cross(up, side) of the torso (unnormalised; times fwdSign it points the way the body faced). */
  private forward(out: number[]) {
    const p = this.pos;
    const ux = p[RP.chest * 3] - p[RP.pelvis * 3], uy = p[RP.chest * 3 + 1] - p[RP.pelvis * 3 + 1], uz = p[RP.chest * 3 + 2] - p[RP.pelvis * 3 + 2];
    const sx = p[RP.shL * 3] - p[RP.shR * 3], sy = p[RP.shL * 3 + 1] - p[RP.shR * 3 + 1], sz = p[RP.shL * 3 + 2] - p[RP.shR * 3 + 2];
    out[0] = uy * sz - uz * sy; out[1] = uz * sx - ux * sz; out[2] = ux * sy - uy * sx;
    return out;
  }

  /** Unit forward of the torso (the way the chest faces). */
  facing(out: number[] = [0, 0, 0]) {
    const f = this.forward(out), l = Math.hypot(f[0], f[1], f[2]) || 1;
    for (let c = 0; c < 3; c++) f[c] *= this.fwdSign / l;
    return f;
  }

  dist(a: number, b: number) {
    const p = this.pos;
    return Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
  }
}
const _f = [0, 0, 0], _t = new Array<number>(12).fill(0);

/** How many ragdolls may simulate at once (asleep ones are free); over the cap a death plays the clip. */
export const RAGDOLL_MAX = 6;
let awake = 0;
export const ragdollBudget = {
  get awake() { return awake; },
  acquire(): boolean { if (awake >= RAGDOLL_MAX) return false; awake++; return true; },
  release() { awake = Math.max(0, awake - 1); },
  /** tests */
  reset() { awake = 0; },
};

/** Push (m/s) a killing blow gives the body: per weapon, explosions also lift. */
export function deathKick(weapon: string | undefined, explosive: boolean): { push: number; lift: number } {
  if (explosive) return { push: 3.4, lift: 3.4 };
  switch (weapon) {
    case 'shotgun': return { push: 3.6, lift: 0.4 };
    case 'rifle': return { push: 3, lift: 0.2 };
    case 'sniper': return { push: 4.2, lift: 0.3 };
    case 'fists': return { push: 2.6, lift: 0.3 };
    case 'smg': return { push: 1.8, lift: 0.1 };
    case 'pistol': return { push: 2, lift: 0.1 };
    default: return { push: 1.2, lift: 0 };
  }
}

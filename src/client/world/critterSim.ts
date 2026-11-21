/**
 * Wildlife behaviour: one small agent framework, species as data (critterSpecies.ts). Client-only cosmetics: no sim
 * or gameplay effect. Pure logic (no three.js); critters.ts draws the agents. Deterministic per seed + inputs.
 *
 * Every agent lives at a habitat anchor (critterHabitats.ts) and cycles idle ↔ short moves inside it. A player
 * within the species' fear radius, a shot (shooter or impact) or an explosion nearby triggers its flee style:
 *   hide  sprint away, duck out of sight (hole, burrow, shell, crevice), re-emerge a while later
 *   run   bolt away, settle again further off
 *   fly   take off, circle overhead, land back on the anchor once it's quiet
 *   sink  (water) drop deeper and drift off
 * Only agents near the camera exist (spawned within a radius, despawned beyond it, capped per quality preset), and
 * agents off screen don't update (`View.visible` is the culling predicate).
 */
import type { Anchor, Habitats } from './critterHabitats';
import { SPECIES_DEFS, type SpeciesDef } from './critterSpecies';
import { waveHeight, waveTime } from './waves';

export type CritterQuality = 'low' | 'high' | 'ultra';
export type State = 'hidden' | 'idle' | 'move' | 'flee' | 'rest' | 'freeze' | 'bark' | 'fly' | 'circle' | 'dive' | 'jump';

export type Agent = {
  id: number; def: SpeciesDef; home: Anchor; homeIdx: number; rnd: () => number;
  x: number; y: number; z: number; yaw: number;
  /** wall climbers: position in the wall panel (m) and heading in its plane (rad) */
  ws: number; wh: number; head: number;
  st: State; t: number;
  tx: number; ty: number; tz: number;
  /** flights: start point, duration, elapsed, arc height; `dive` = plunge at the end */
  fx: number; fy: number; fz: number; fdur: number; fage: number; arc: number; dive: boolean;
  speed: number;
  /** animation: gait phase (rad), gait 0..1 (legs / wing beat), pose 0..1 (sniff / peck / nap / claws), shown 0..1 */
  phase: number; gait: number; pose: number; show: number;
  cd: number; seen: boolean;
  /** a walker found itself off the ground (should not happen): removed at the end of the frame */
  lost?: boolean;
};

export type V3 = { x: number; y: number; z: number };
export type View = {
  cam: V3;
  /** camera forward (unit) */
  fwd: V3;
  /** live player feet positions */
  players: V3[];
  /** culling predicate: is a sphere (x, y, z, r) on screen */
  visible: (x: number, y: number, z: number, r: number) => boolean;
  /** gameplay water level (visual waves ride on it) */
  waterY: number;
};
export type CritterSound = { kind: string; x: number; y: number; z: number };

type Noise = { kind: 'shot' | 'explosion'; pts: V3[]; age: number };

/** Mulberry32: tiny deterministic PRNG. */
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rr = (r: () => number, a: number, b: number) => a + (b - a) * r();
const d2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) ** 2 + (az - bz) ** 2;
const TAU = Math.PI * 2;
function turn(from: number, to: number, k: number) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return from + d * Math.min(1, k);
}
/** three.js yaw of a heading (forward = -Z). */
export const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);
/** Big animals never pop in on screen: they spawn off screen or at least this far away. */
const POP_R = 25;

export class CritterSim {
  readonly agents: Agent[] = [];
  readonly sounds: CritterSound[] = [];
  quality: CritterQuality = 'high';
  private noises: Noise[] = [];
  private nextId = 1;
  private spawns = 0;
  private spawnClock = 0;
  private flockClock = 8;
  private rnd: () => number;
  /** agents per (species, anchor index) */
  private used = new Map<string, number>();

  constructor(readonly hab: Habitats, readonly seed: number, readonly defs: SpeciesDef[] = SPECIES_DEFS) {
    this.rnd = mulberry(seed ^ 0x9e3779b9);
  }

  /** A gunshot (shooter, impact) or explosion happened at these points. */
  noise(kind: 'shot' | 'explosion', pts: V3[]) { this.noises.push({ kind, pts, age: 0 }); }

  count(name: string) { let n = 0; for (const a of this.agents) if (a.def.name === name) n++; return n; }

  update(dtIn: number, v: View) {
    const dt = Math.min(0.1, Math.max(0, dtIn));
    this.spawnClock -= dt;
    if (this.spawnClock <= 0) { this.spawnClock = 0.25; this.populate(v); }
    for (const a of this.agents) {
      // paused off screen (a bird that already took off finishes its flight)
      if (a.st !== 'fly' && a.st !== 'circle' && !v.visible(a.x, a.y, a.z, 1 + a.def.size)) continue;
      this.step(a, dt, v);
    }
    this.flockClock -= dt;
    if (this.flockClock <= 0) { this.flockClock = rr(this.rnd, 12, 25); this.flockFlight(v); }
    for (let i = this.agents.length - 1; i >= 0; i--) if (this.agents[i].lost) { console.warn(`[critters] ${this.agents[i].def.name} off the ground; removed`); this.remove(i); }
    for (const n of this.noises) n.age += dt;
    this.noises = this.noises.filter((n) => n.age < 0.3);
  }

  /** Life moment: a calm, visible flock (pigeons) takes off together, circles and lands again. */
  private flockFlight(v: View) {
    const lead = this.agents.find((a) => a.def.flockFlights && a.st === 'idle' && v.visible(a.x, a.y, a.z, 2));
    if (!lead) return;
    const flock = this.agents.filter((a) => a.def === lead.def && a.homeIdx === lead.homeIdx && (a.st === 'idle' || a.st === 'move'));
    for (const a of flock) {
      a.tx = a.home.x + rr(a.rnd, -3, 3); a.tz = a.home.z + rr(a.rnd, -3, 3); a.ty = a.y + rr(a.rnd, 4, 7);
      a.arc = rr(a.rnd, 3, 6); a.fage = rr(a.rnd, 0, TAU); a.st = 'circle'; a.t = rr(a.rnd, 3, 6);
    }
    this.sound('flap', lead, v);
  }

  // ------------------------------------------------------------------ spawning

  private populate(v: View) {
    for (const def of this.defs) {
      const cap = def.cap[this.quality];
      const R = def.spawnR, R2 = R * R, D2 = (R * 1.35) ** 2;
      for (let i = this.agents.length - 1; i >= 0; i--) {
        const a = this.agents[i];
        if (a.def !== def) continue;
        const dd = d2(a.x, a.z, v.cam.x, v.cam.z);
        // small ones go as soon as they're out of range; big ones once unseen (or twice the range: a speck by then)
        if (dd > D2 && (def.size < 0.3 || dd > 4 * R2 || !v.visible(a.x, a.y, a.z, 1.5))) this.remove(i);
      }
      let n = this.count(def.name);
      while (n > cap) {
        let far = -1, fd = -1;
        this.agents.forEach((a, i) => { if (a.def === def) { const d = d2(a.x, a.z, v.cam.x, v.cam.z); if (d > fd) { fd = d; far = i; } } });
        this.remove(far); n--;
      }
      const list = this.anchors(def);
      const cand: number[] = [];
      for (let i = 0; i < list.length; i++) {
        if ((this.used.get(`${def.name}:${i}`) ?? 0) >= def.perAnchor) continue;
        const p = list[i];
        const dd = d2(p.x, p.z, v.cam.x, v.cam.z);
        if (dd > R2) continue;
        // big animals never pop in on screen, except flyers: they arrive by flying in and landing
        if (def.size >= 0.3 && !def.emerges && def.flee !== 'fly' && dd < POP_R * POP_R && v.visible(p.x, p.y, p.z, 1.5)) continue;
        cand.push(i);
      }
      // favour anchors in view and close (ahead of the camera), with some randomness
      const score = (i: number) => {
        const p = list[i];
        return Math.sqrt(d2(p.x, p.z, v.cam.x, v.cam.z)) * (v.visible(p.x, p.y, p.z, 1) ? 1 : 3);
      };
      const scores = new Map(cand.map((i) => [i, score(i)]));
      cand.sort((a, b) => scores.get(a)! - scores.get(b)!);
      if (n >= cap) {
        // recycle: with the cap reached, one animal that's off screen makes room for a spot in view near the
        // camera, so the view stays populated instead of the budget piling up behind the player
        const best = cand[0];
        if (best === undefined) continue;
        const bp = list[best];
        if (!v.visible(bp.x, bp.y, bp.z, 1)) continue;
        let far = -1, fd = -1;
        this.agents.forEach((a, i) => {
          if (a.def !== def || a.st === 'fly' || a.st === 'circle' || v.visible(a.x, a.y, a.z, 1 + def.size)) return;
          const d = d2(a.x, a.z, v.cam.x, v.cam.z);
          if (d > fd) { fd = d; far = i; }
        });
        if (far < 0) continue;
        this.remove(far); n--;
      }
      while (n < cap && cand.length) {
        const k = Math.floor(this.rnd() ** 2 * cand.length);
        const i = cand[k];
        // flocks: fill the anchor up in one go
        const group = Math.min(cap - n, def.perAnchor - (this.used.get(`${def.name}:${i}`) ?? 0));
        const p = list[i], inView = v.visible(p.x, p.y, p.z, 1.5) && d2(p.x, p.z, v.cam.x, v.cam.z) < POP_R * POP_R;
        for (let g = 0; g < group; g++) {
          const a = this.spawn(def, i); n++;
          if (inView && def.flee === 'fly') this.flyIn(a, v);
        }
        cand.splice(k, 1);
      }
    }
  }

  private anchors(def: SpeciesDef): Anchor[] {
    return def.habitat.length === 1 ? this.hab[def.habitat[0]] : def.habitat.flatMap((h) => this.hab[h]);
  }

  private remove(i: number) {
    const a = this.agents[i];
    const key = `${a.def.name}:${a.homeIdx}`;
    const c = (this.used.get(key) ?? 1) - 1;
    if (c <= 0) this.used.delete(key); else this.used.set(key, c);
    this.agents.splice(i, 1);
  }

  /** Create an agent of `def` at anchor index `idx` (hidden first if it emerges from a hole). */
  spawn(def: SpeciesDef, idx: number): Agent {
    const rnd = mulberry((this.seed * 31 + this.defs.indexOf(def) * 7919 + ++this.spawns * 104729) >>> 0);
    const h = this.anchors(def)[idx];
    const an = rr(rnd, 0, TAU), r = Math.sqrt(rnd()) * h.r;
    const a: Agent = {
      id: this.nextId++, def, home: h, homeIdx: idx, rnd,
      x: h.x + Math.cos(an) * r, y: h.y, z: h.z + Math.sin(an) * r, yaw: def.mode === 'perch' ? h.yaw : rr(rnd, 0, TAU),
      ws: h.wall ? rr(rnd, 0.3, h.wall.w - 0.3) : 0, wh: h.wall ? rr(rnd, 0.2, h.wall.h - 0.2) : 0, head: rr(rnd, 0, TAU),
      st: 'idle', t: rr(rnd, 0.3, 3), tx: 0, ty: 0, tz: 0,
      fx: 0, fy: 0, fz: 0, fdur: 1, fage: 0, arc: 0, dive: false,
      speed: 0, phase: rr(rnd, 0, TAU), gait: 0, pose: 0, show: 1, cd: rr(rnd, 1, 6), seen: false,
    };
    if (!this.onHome(a, a.x, a.z)) { a.x = h.x; a.z = h.z; }
    if (def.emerges) { a.st = 'hidden'; a.show = 0; }
    if (def.rest && rnd() < def.rest.chance) { a.st = 'rest'; a.t = rr(rnd, def.rest.time[0], def.rest.time[1]); a.pose = 1; }
    this.place(a);
    const key = `${def.name}:${idx}`;
    this.used.set(key, (this.used.get(key) ?? 0) + 1);
    this.agents.push(a);
    return a;
  }

  /** Base height of the anchor (water anchors ride the live sea level). */
  private baseY(a: Agent, waterY: number) { return a.home.water ? waterY + a.home.y : a.home.y; }

  private place(a: Agent, waterY = 0) {
    const w = a.home.wall;
    if (w) { a.x = a.home.x + w.ux * a.ws + w.nx * 0.02; a.y = a.home.y + a.wh; a.z = a.home.z + w.uz * a.ws + w.nz * 0.02; }
    else if (a.def.mode === 'perch' && (a.st === 'idle' || a.st === 'rest')) { a.x = a.home.x; a.y = a.home.y; a.z = a.home.z; }
    else if (a.def.mode === 'ground' && a.home.grounded && a.st !== 'fly' && a.st !== 'circle') {
      const g = this.hab.ground(a.x, a.z);
      if (g === null) a.lost = true; else a.y = g;
    } else if (a.def.mode !== 'perch' && a.st !== 'jump') {
      a.y = this.baseY(a, waterY);
      if (a.def.mode === 'water' || a.def.wades) a.y += waveHeight(a.x, a.z, waveTime()) * (a.def.mode === 'water' ? 0.6 : 0);
    }
  }

  // ------------------------------------------------------------------ behaviour

  private threat(a: Agent, v: View): V3 | null {
    const [rp, rs, rb] = a.def.fear;
    let best: V3 | null = null, bd = Infinity;
    const consider = (p: V3, r: number) => {
      if (r <= 0) return;
      const d = (a.x - p.x) ** 2 + (a.y - p.y) ** 2 * 0.25 + (a.z - p.z) ** 2;
      if (d < r * r && d < bd) { bd = d; best = p; }
    };
    for (const p of v.players) consider(p, rp);
    for (const n of this.noises) n.pts.forEach((p, i) => consider(p, n.kind === 'explosion' ? rb : i === 0 ? rs : rs * 0.6));
    return best;
  }

  private sound(kind: string | undefined, a: Agent, v: View) {
    if (kind && d2(a.x, a.z, v.cam.x, v.cam.z) < 24 * 24) this.sounds.push({ kind, x: a.x, y: a.y, z: a.z });
  }

  private step(a: Agent, dt: number, v: View) {
    const D = a.def;
    a.t -= dt; a.cd -= dt;
    const calm = a.st === 'idle' || a.st === 'move' || a.st === 'rest' || a.st === 'freeze' || a.st === 'bark';
    const th = calm ? this.threat(a, v) : null;
    if (th) this.flee(a, th, v);

    // dogs bark at the nearest player in range, then trot off
    if (D.bark && calm && a.cd <= 0 && a.st !== 'bark') {
      for (const p of v.players) if (d2(p.x, p.z, a.x, a.z) < D.bark * D.bark) { a.st = 'bark'; a.t = rr(a.rnd, 1.2, 2.2); a.cd = rr(a.rnd, 10, 18); a.tx = p.x; a.tz = p.z; a.fage = 0; break; }
    }
    // climbers freeze when looked at (once per emergence), then skitter off
    if (D.freezeOnLook && (a.st === 'idle' || a.st === 'move') && !a.seen) {
      const dx = a.x - v.cam.x, dy = a.y - v.cam.y, dz = a.z - v.cam.z, l = Math.hypot(dx, dy, dz);
      if (l < 14 && (dx * v.fwd.x + dy * v.fwd.y + dz * v.fwd.z) / l > 0.985) { a.st = 'freeze'; a.t = rr(a.rnd, 0.7, 1.6); a.seen = true; }
    }

    switch (a.st) {
      case 'hidden':
        a.show = Math.max(0, a.show - dt * 4); a.speed = 0; a.gait = 0;
        if (a.t <= 0) {
          let near = false;
          for (const p of v.players) if (d2(p.x, p.z, a.home.x, a.home.z) < (D.fear[0] + 2) ** 2) near = true;
          if (near) a.t = rr(a.rnd, 1, 3);
          else { a.st = 'idle'; a.t = rr(a.rnd, D.idle[0], D.idle[1]); a.seen = false; this.relocate(a); }
        }
        break;
      case 'rest':
        a.speed = 0; a.gait = 0; a.pose = 1;
        if (a.t <= 0) { a.st = 'idle'; a.t = rr(a.rnd, D.idle[0], D.idle[1]); }
        break;
      case 'idle':
        a.speed = 0; a.gait = Math.max(0, a.gait - dt * 6);
        a.pose = D.idlePose ? 0.5 + 0.5 * Math.sin(a.phase * D.idlePose) : 0;
        if (a.t <= 0) {
          if (D.mode === 'perch') this.perchIdle(a, v);
          else if (D.jumps && a.rnd() < 0.5) this.jump(a);
          else this.wander(a);
          if (a.rnd() < D.soundChance) this.sound(D.sound, a, v);
        }
        break;
      case 'freeze':
        a.speed = 0; a.gait = 0; a.pose = 0;
        if (a.t <= 0) this.flee(a, v.cam, v);
        break;
      case 'bark':
        a.speed = 0; a.gait = 0; a.pose = 0.5 + 0.5 * Math.sin(a.phase * 3);
        a.yaw = turn(a.yaw, yawOf(a.tx - a.x, a.tz - a.z), dt * 8);
        a.fage -= dt;
        if (a.fage <= 0) { this.sound('bark', a, v); a.fage = rr(a.rnd, 0.35, 0.6); }
        if (a.t <= 0) { this.away(a, a.tx, a.tz, 6); a.st = 'move'; a.t = 6; }
        break;
      case 'move': case 'flee': {
        const sp = a.st === 'flee' ? D.run : D.walk;
        a.speed = sp; a.gait = Math.min(1, a.gait + dt * 8); a.pose = 0;
        if (a.home.wall) {
          const dx = a.tx - a.ws, dy = a.ty - a.wh, l = Math.hypot(dx, dy);
          if (l < 0.03 || a.t <= 0) this.arrive(a);
          else { const k = Math.min(l, sp * dt) / l; a.ws += dx * k; a.wh += dy * k; a.head = Math.atan2(dy, dx); }
        } else {
          const dx = a.tx - a.x, dz = a.tz - a.z, l = Math.hypot(dx, dz);
          if (l < 0.04 || a.t <= 0) this.arrive(a);
          else {
            const k = Math.min(l, sp * dt) / l;
            // every step stays on its ground (or inside its patch): at an edge, stop and settle / duck away
            if (!this.onHome(a, a.x + dx * k, a.z + dz * k)) { this.arrive(a); break; }
            a.x += dx * k; a.z += dz * k;
            if (!D.sidestep) a.yaw = turn(a.yaw, yawOf(dx, dz), dt * 10);
          }
        }
        break;
      }
      case 'jump': {
        // a fish leaping clear of the water in an arc
        a.fage += dt;
        const k = Math.min(1, a.fage / a.fdur);
        a.x = a.fx + (a.tx - a.fx) * k; a.z = a.fz + (a.tz - a.fz) * k;
        a.y = this.baseY(a, v.waterY) + Math.sin(Math.PI * k) * a.arc - 0.2;
        a.pose = k; a.gait = 1;
        if (k >= 1) { a.st = 'idle'; a.t = rr(a.rnd, D.idle[0], D.idle[1]); this.sound(D.sound, a, v); }
        break;
      }
      case 'fly': {
        a.fage += dt;
        const k = Math.min(1, a.fage / a.fdur), e = k * k * (3 - 2 * k);
        const px = a.x, pz = a.z;
        a.x = a.fx + (a.tx - a.fx) * e; a.z = a.fz + (a.tz - a.fz) * e;
        a.y = a.fy + (a.ty - a.fy) * e + Math.sin(Math.PI * k) * a.arc;
        a.speed = 6; a.gait = 1; a.pose = 0;
        if (Math.abs(a.x - px) + Math.abs(a.z - pz) > 1e-4) a.yaw = turn(a.yaw, yawOf(a.x - px, a.z - pz), dt * 8);
        if (k >= 1) {
          if (a.dive) { a.st = 'dive'; a.fage = 0; a.fy = a.y; }
          else { a.st = 'idle'; a.t = rr(a.rnd, D.idle[0], D.idle[1]); a.gait = 0; if (D.mode === 'perch') a.yaw = a.home.yaw; }
        }
        break;
      }
      case 'dive': {
        a.fage += dt;
        const k = Math.min(1, a.fage / 0.45);
        const sea = v.waterY + waveHeight(a.x, a.z, waveTime());
        if (k < 1) a.y = a.fy + (sea - 0.25 - a.fy) * k * k;
        else a.y += (sea - a.y) * Math.min(1, dt * 5); // bob on the surface with the catch
        a.gait = 0; a.pose = k < 1 ? 1 : 0.3; a.speed = 0;
        if (a.fage > 0.45 + rr(a.rnd, 1.5, 3)) { this.fly(a, a.home.x, a.home.y, a.home.z, 2, false); this.sound('flap', a, v); }
        break;
      }
      case 'circle': {
        a.fage += dt * 0.6;
        const px = a.x, pz = a.z;
        a.x += (a.tx + Math.cos(a.fage) * a.arc - a.x) * Math.min(1, dt * 1.5);
        a.z += (a.tz + Math.sin(a.fage) * a.arc - a.z) * Math.min(1, dt * 1.5);
        a.y += (a.ty - a.y) * Math.min(1, dt * 1.2);
        a.speed = 6; a.gait = 1; a.pose = 0;
        a.yaw = turn(a.yaw, yawOf(a.x - px, a.z - pz), dt * 6);
        if (a.t <= 0) {
          let near = false;
          for (const p of v.players) if (d2(p.x, p.z, a.home.x, a.home.z) < (D.fear[0] + 2) ** 2) near = true;
          if (near) a.t = rr(a.rnd, 3, 6);
          else {
            let lx = a.home.x + (a.home.r ? rr(a.rnd, -a.home.r, a.home.r) : 0), lz = a.home.z + (a.home.r ? rr(a.rnd, -a.home.r, a.home.r) : 0);
            if (!this.onHome(a, lx, lz)) { lx = a.home.x; lz = a.home.z; }
            this.fly(a, lx, a.home.grounded ? this.hab.ground(lx, lz) ?? a.home.y : a.home.y, lz, 2.5, false);
          }
        }
        break;
      }
    }
    if (a.st !== 'hidden') a.show = Math.min(1, a.show + dt * 3);
    if (a.st !== 'fly' && a.st !== 'circle' && a.st !== 'dive') this.place(a, v.waterY);
    a.phase = (a.phase + dt * (D.mode === 'perch' || a.st === 'fly' || a.st === 'circle' ? 14 : D.stepRate * (0.4 + a.speed))) % (TAU * 64);
  }

  /** Start a just-spawned flyer up and away from its spot (away from the camera), gliding in to land there. */
  private flyIn(a: Agent, v: View) {
    const tx = a.x, ty = a.y, tz = a.z;
    const ax = a.x - v.cam.x, az = a.z - v.cam.z, l = Math.hypot(ax, az) || 1;
    a.x += (ax / l) * 14 + rr(a.rnd, -4, 4); a.z += (az / l) * 14 + rr(a.rnd, -4, 4); a.y = ty + rr(a.rnd, 7, 11);
    this.fly(a, tx, ty, tz, 1.5, false);
    a.show = 1;
  }

  private flee(a: Agent, th: V3, v: View) {
    const D = a.def;
    this.sound(D.fleeSound ?? D.sound, a, v);
    if (D.flee === 'none') return;
    if (D.flee === 'fly') {
      const ax = a.x - th.x, az = a.z - th.z, l = Math.hypot(ax, az) || 1;
      a.tx = a.x + (ax / l) * 10; a.tz = a.z + (az / l) * 10; a.ty = Math.max(a.y, v.waterY) + rr(a.rnd, 5, 9);
      a.arc = rr(a.rnd, 5, 9); a.fage = rr(a.rnd, 0, TAU);
      a.st = 'circle'; a.t = rr(a.rnd, 6, 12);
      this.sound('flap', a, v);
      return;
    }
    if (a.home.wall) {
      const w = a.home.wall;
      a.tx = a.ws < w.w / 2 ? 0 : w.w; a.ty = Math.min(w.h, Math.max(0, a.wh + rr(a.rnd, -0.4, 0.4)));
    } else {
      // scurry for cover on land: the most direct escape whose end point is still walkable ground
      this.away(a, th.x, th.z, D.fleeDist);
      if (!this.onHome(a, a.tx, a.tz)) {
        const bx = a.x - th.x, bz = a.z - th.z, base = Math.atan2(bz, bx);
        for (const off of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8, Math.PI]) {
          const ang = base + off, d = D.fleeDist * 0.7;
          const tx = a.x + Math.cos(ang) * d, tz = a.z + Math.sin(ang) * d;
          if (this.onHome(a, tx, tz)) { a.tx = tx; a.tz = tz; break; }
        }
      }
      if (D.sidestep) a.yaw = yawOf(a.tz - a.z, -(a.tx - a.x)); // run sideways
    }
    a.st = 'flee'; a.t = rr(a.rnd, 0.6, 1.3) * (D.fleeDist / Math.max(1, D.run));
  }

  /** Target `dist` m away from (x, z), kept within 1.6× the home radius (+ 1 m). */
  private away(a: Agent, x: number, z: number, dist: number) {
    const ax = a.x - x, az = a.z - z, l = Math.hypot(ax, az) || 1;
    let tx = a.x + (ax / l) * dist, tz = a.z + (az / l) * dist;
    const h = a.home, R = h.grounded ? h.r * 1.6 + 1 : h.r, dx = tx - h.x, dz = tz - h.z, dl = Math.hypot(dx, dz);
    if (dl > R) { tx = h.x + (dx / dl) * R; tz = h.z + (dz / dl) * R; }
    a.tx = tx; a.tz = tz;
  }

  private arrive(a: Agent) {
    const D = a.def;
    if (a.st === 'flee' && D.flee === 'hide') { const h = D.hideTime ?? [4, 10]; a.st = 'hidden'; a.t = rr(a.rnd, h[0], h[1]); return; }
    if (D.rest && a.rnd() < D.rest.chance * 0.4) { a.st = 'rest'; a.t = rr(a.rnd, D.rest.time[0], D.rest.time[1]); return; }
    a.st = 'idle'; a.t = rr(a.rnd, D.idle[0], D.idle[1]);
  }

  /** Short move somewhere inside the home patch / wall. */
  private wander(a: Agent) {
    const D = a.def, h = a.home;
    if (h.wall) {
      a.tx = Math.min(h.wall.w - 0.2, Math.max(0.2, a.ws + rr(a.rnd, -D.hop, D.hop)));
      a.ty = Math.min(h.wall.h - 0.15, Math.max(0.15, a.wh + rr(a.rnd, -D.hop * 0.5, D.hop * 0.5)));
    } else if (D.sidestep) {
      const side = a.rnd() < 0.5 ? -1 : 1, d = rr(a.rnd, 0.3, D.hop);
      const sx = Math.cos(a.yaw) * side, sz = -Math.sin(a.yaw) * side;
      a.tx = a.x + sx * d; a.tz = a.z + sz * d;
      if (d2(a.tx, a.tz, h.x, h.z) > h.r * h.r) { a.tx = a.x - sx * d; a.tz = a.z - sz * d; }
    } else {
      const an = rr(a.rnd, 0, TAU), r = Math.sqrt(a.rnd()) * h.r;
      let tx = h.x + Math.cos(an) * r, tz = h.z + Math.sin(an) * r;
      // short darts: no further than `hop` per move
      const dx = tx - a.x, dz = tz - a.z, l = Math.hypot(dx, dz);
      if (l > D.hop) { tx = a.x + (dx / l) * D.hop; tz = a.z + (dz / l) * D.hop; }
      a.tx = tx; a.tz = tz;
    }
    a.st = 'move'; a.t = rr(a.rnd, D.move[0], D.move[1]);
  }

  /** After hiding: come back out somewhere else on the home patch. */
  private relocate(a: Agent) {
    if (a.home.wall || a.home.r <= 0) return;
    const an = rr(a.rnd, 0, TAU), r = Math.sqrt(a.rnd()) * a.home.r;
    const x = a.home.x + Math.cos(an) * r, z = a.home.z + Math.sin(an) * r;
    if (this.onHome(a, x, z)) { a.x = x; a.z = z; }
  }

  /** Walkers on map ground stay on it (no quay-edge or water steps, no >0.6 m drops); the rest keep to their patch. */
  onHome(a: Agent, x: number, z: number): boolean {
    const h = a.home;
    if (a.def.mode !== 'ground' || h.wall) return true;
    if (h.grounded) {
      const g = this.hab.ground(x, z);
      return g !== null && Math.abs(g - h.y) < 0.6;
    }
    return (x - h.x) ** 2 + (z - h.z) ** 2 <= h.r * h.r + 1e-6;
  }

  private perchIdle(a: Agent, v: View) {
    const D = a.def;
    a.t = rr(a.rnd, D.idle[0], D.idle[1]);
    if (!D.fishes || a.rnd() > 0.4) return;
    for (let k = 0; k < 6; k++) {
      const an = rr(a.rnd, 0, TAU), r = rr(a.rnd, 8, 18);
      const x = a.home.x + Math.cos(an) * r, z = a.home.z + Math.sin(an) * r;
      if (this.hab.land(x, z)) continue;
      this.fly(a, x, v.waterY + rr(a.rnd, 4, 6), z, 1.5, true);
      this.sound('flap', a, v);
      return;
    }
  }

  private jump(a: Agent) {
    const an = rr(a.rnd, 0, TAU), d = rr(a.rnd, 0.8, 1.6);
    a.fx = a.x; a.fz = a.z; a.tx = a.x + Math.cos(an) * d; a.tz = a.z + Math.sin(an) * d;
    a.yaw = yawOf(a.tx - a.x, a.tz - a.z);
    a.fdur = rr(a.rnd, 0.45, 0.7); a.fage = 0; a.arc = rr(a.rnd, 0.5, 0.9);
    a.st = 'jump';
  }

  private fly(a: Agent, x: number, y: number, z: number, arc: number, dive: boolean) {
    a.fx = a.x; a.fy = a.y; a.fz = a.z; a.tx = x; a.ty = y; a.tz = z;
    a.fdur = Math.max(1, Math.hypot(x - a.x, y - a.y, z - a.z) / 6); a.fage = 0; a.arc = arc; a.dive = dive;
    a.st = 'fly';
  }
}

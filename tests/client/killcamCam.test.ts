import { beforeAll, describe, expect, it } from 'vitest';
import { emptyInventory } from '../../src/sim/economy';
import type { MatchEvent, MatchEventType, PlayerState, Snapshot, Vec3 } from '../../src/sim/types';
import { sees, SHOT, smoothDamp, smoothDampV3, solveTwoShot, sweepCamera, SWEEP, type Raycast, type TwoShotOut } from '../../src/client/camPath';
import {
  findKillShot, KILLCAM_SEC, MIN_LEAD_IN, planKillcam, realSpan, RESPAWN_MARGIN, sampleSmooth, SLOW_LEAD_MAX, SLOW_LEAD_MIN, slowAmount, slowLead, SLOWMO, timeScale,
} from '../../src/client/qol/killcamBuffer';

// ---- a box world for the raycast ----------------------------------------------------------------

type Box = { min: Vec3; max: Vec3 };
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

/** Slab-method ray vs boxes: first hit distance (rays starting inside a box hit it at 0). */
function boxRaycast(boxes: Box[]): Raycast {
  return (o, d, far) => {
    let best: number | null = null;
    for (const b of boxes) {
      let t0 = 0, t1 = far;
      let ok = true;
      for (const k of ['x', 'y', 'z'] as const) {
        if (Math.abs(d[k]) < 1e-9) { if (o[k] < b.min[k] || o[k] > b.max[k]) { ok = false; break; } continue; }
        let a = (b.min[k] - o[k]) / d[k], c = (b.max[k] - o[k]) / d[k];
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, c);
        if (t0 > t1) { ok = false; break; }
      }
      if (ok && (best === null || t0 < best)) best = t0;
    }
    return best;
  };
}
const inside = (p: Vec3, boxes: Box[]) => boxes.some((b) => p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z);
const chest = (f: Vec3, h: number) => ({ x: f.x, y: f.y + h, z: f.z });
/** Angle (rad) between the camera's view (pos → look) and the direction to `p`. */
function offAxis(o: TwoShotOut, p: Vec3) {
  const ax = o.look.x - o.pos.x, ay = o.look.y - o.pos.y, az = o.look.z - o.pos.z;
  const bx = p.x - o.pos.x, by = p.y - o.pos.y, bz = p.z - o.pos.z;
  return Math.acos(Math.min(1, (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz))));
}
/** Inside a 70° vertical FOV at 16:9 (horizontal ≈ 102°): within ~40° of the axis is comfortably framed. */
const FRAMED = (40 * Math.PI) / 180;
const newOut = (): TwoShotOut => ({ pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, side: 1, clear: false });

const K: Vec3 = { x: 0, y: 0, z: 0 }; // killer's feet
const V: Vec3 = { x: 0, y: 0, z: -15 }; // victim's feet, 15 m ahead

describe('camera path solver (camPath.solveTwoShot)', () => {
  it('open ground: both players framed and in sight, wide from the side → over the shoulder toward the victim', () => {
    const rc = boxRaycast([]);
    const wide = solveTwoShot({ subject: K, target: V, blend: 0, side: 1, raycast: rc }, newOut());
    expect(wide.clear).toBe(true);
    expect(Math.abs(wide.pos.x)).toBeGreaterThan(5); // off to the side of the pair
    const sh = solveTwoShot({ subject: K, target: V, blend: 1, side: 1, raycast: rc }, newOut());
    expect(sh.clear).toBe(true);
    expect(sh.pos.z).toBeGreaterThan(K.z + 2); // behind the killer...
    expect(Math.abs(sh.pos.x)).toBeLessThan(1.2); // ...just off their shoulder
    for (const o of [wide, sh]) {
      expect(offAxis(o, chest(K, SHOT.subjectChest))).toBeLessThan(FRAMED);
      expect(offAxis(o, chest(V, SHOT.targetChest))).toBeLessThan(FRAMED);
    }
  });

  it('a wall right behind the killer: pulled in front of it, never inside, still sees both', () => {
    const walls = [box(-4, 0, 1.2, 4, 4, 1.6)];
    const o = solveTwoShot({ subject: K, target: V, blend: 1, side: 1, raycast: boxRaycast(walls) }, newOut());
    expect(inside(o.pos, walls)).toBe(false);
    expect(o.pos.z).toBeLessThan(1.2);
    expect(o.clear).toBe(true);
  });

  it('the preferred side is blocked: takes the other side or rises above, keeping line of sight to both', () => {
    const walls = [box(2, 0, -14, 2.6, 5, -1)]; // a long wall right of the pair
    const rc = boxRaycast(walls);
    const o = solveTwoShot({ subject: K, target: V, blend: 0, side: 1, raycast: rc }, newOut());
    expect(inside(o.pos, walls)).toBe(false);
    expect(o.clear).toBe(true);
    expect(sees(o.pos, chest(K, SHOT.subjectChest), rc)).toBe(true);
    expect(sees(o.pos, chest(V, SHOT.targetChest), rc)).toBe(true);
  });

  it('random clutter: never inside geometry; reported line of sight is real; almost always keeps both in view', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let clear = 0;
    const N = 300;
    for (let n = 0; n < N; n++) {
      const v: Vec3 = { x: (rnd() - 0.5) * 30, y: 0, z: -4 - rnd() * 20 };
      const boxes: Box[] = [];
      for (let i = 0; i < 6; i++) {
        const cx = (rnd() - 0.5) * 30, cz = 6 - rnd() * 30, w = 0.3 + rnd() * 3, d = 0.3 + rnd() * 3, h = 1 + rnd() * 4;
        const b = box(cx - w / 2, 0, cz - d / 2, cx + w / 2, h, cz + d / 2);
        // Not on top of either player.
        if (inside(chest(K, 1), [b]) || inside(chest(v, 1), [b])) continue;
        boxes.push(b);
      }
      const rc = boxRaycast(boxes);
      const o = solveTwoShot({ subject: K, target: v, blend: rnd(), side: rnd() < 0.5 ? 1 : -1, raycast: rc }, newOut());
      expect(inside(o.pos, boxes)).toBe(false);
      if (o.clear) {
        clear++;
        expect(sees(o.pos, chest(K, SHOT.subjectChest), rc)).toBe(true);
        expect(sees(o.pos, chest(v, SHOT.targetChest), rc)).toBe(true);
      }
    }
    // Only a player boxed in on every side can't be seen (the victim behind a wall from every angle).
    expect(clear / N).toBeGreaterThan(0.85);
  });

  it('continuous in the blend: no jumps as it glides from wide to the shoulder', () => {
    const rc = boxRaycast([]);
    const a = newOut(), b = newOut();
    let maxStep = 0;
    for (let i = 1; i <= 100; i++) {
      solveTwoShot({ subject: K, target: V, blend: (i - 1) / 100, side: 1, raycast: rc }, a);
      solveTwoShot({ subject: K, target: V, blend: i / 100, side: 1, raycast: rc }, b);
      maxStep = Math.max(maxStep, Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z));
    }
    expect(maxStep).toBeLessThan(0.5);
  });
});

describe('solid camera (camPath.sweepCamera)', () => {
  const dt = 1 / 60;
  /** Glides a camera from x = -3 toward x = 3 at `speed` m/s (z = -3, chest height) through `boxes`; every frame drawn. */
  function glide(boxes: Box[], speed: number) {
    const rc = boxRaycast(boxes);
    const cam = { x: -3, y: 1.5, z: -3 };
    let maxStep = 0, stops = 0;
    for (let i = 1; i <= Math.ceil(6 / (speed * dt)); i++) {
      const to = { x: Math.min(3, cam.x + speed * dt), y: 1.5, z: -3 };
      if (sweepCamera(cam, to, rc)) stops++;
      maxStep = Math.max(maxStep, Math.hypot(to.x - cam.x, to.y - cam.y, to.z - cam.z) / dt);
      expect(inside(to, boxes), `frame ${i} at x=${to.x.toFixed(2)}`).toBe(false);
      cam.x = to.x; cam.y = to.y; cam.z = to.z;
    }
    return { cam, maxStep, stops };
  }

  it('glides past a thin pole between two frames: never drawn inside it, never faster than it was moving', () => {
    for (const speed of [2, 6, 12]) {
      const r = glide([box(-0.12, 0, -3.12, 0.12, 5, -2.88)], speed);
      expect(r.cam.x).toBeCloseTo(3, 5); // got past
      expect(r.stops).toBe(0);
      // At most the pole's thickness plus a skin either side in one frame: a glide, not a jump.
      expect(r.maxStep).toBeLessThanOrEqual(speed + (0.24 + 2 * SWEEP.skin) / dt + 1e-6);
      expect(r.maxStep).toBeLessThan(25);
    }
  });

  it('stops short of a thick prop (a wall): no frame inside, no jump', () => {
    const wall = [box(-0.5, 0, -6, 0.5, 5, 0)];
    const r = glide(wall, 6);
    expect(r.stops).toBeGreaterThan(0);
    expect(r.cam.x).toBeLessThan(-0.5);
    expect(r.cam.x).toBeGreaterThan(-0.5 - SWEEP.skin - 0.11);
    expect(r.maxStep).toBeLessThanOrEqual(6 + 1e-6);
  });

  it('open space: the move is untouched', () => {
    const to = { x: 1, y: 2, z: 3 };
    expect(sweepCamera({ x: 0, y: 2, z: 3 }, to, boxRaycast([]))).toBe(false);
    expect(to).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('camera springs (smoothDamp)', () => {
  it('settles on a fixed target without overshoot, the same at 60 and 144 fps', () => {
    const run = (fps: number) => {
      const v = { v: 0 };
      let x = 0, max = 0;
      for (let i = 0; i < fps; i++) { x = smoothDamp(x, 10, v, 0.25, 1 / fps); max = Math.max(max, x); }
      return { x, max };
    };
    const a = run(60), b = run(144);
    expect(a.max).toBeLessThanOrEqual(10);
    expect(a.x).toBeGreaterThan(9.5);
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.05);
  });

  it('follows a moving target smoothly (no per-frame jumps bigger than the target makes)', () => {
    const cur = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 };
    let maxStep = 0, maxTargetStep = 0;
    const at = (i: number) => ({ x: 5 * Math.sin(i / 120), y: 0, z: i * 0.025 }); // ~5 m/s at 120 fps
    for (let i = 1; i <= 240; i++) {
      const target = at(i), prev = at(i - 1);
      maxTargetStep = Math.max(maxTargetStep, Math.hypot(target.x - prev.x, target.z - prev.z));
      const px = cur.x, pz = cur.z;
      smoothDampV3(cur, target, vel, 0.28, 1 / 120);
      maxStep = Math.max(maxStep, Math.hypot(cur.x - px, cur.z - pz));
    }
    expect(maxStep).toBeLessThanOrEqual(maxTargetStep * 1.05);
  });
});

// ---- timing ---------------------------------------------------------------------------------------

const ME = 1, A = 2;
function player(id: number, pos: Vec3, extra: Partial<PlayerState> = {}): PlayerState {
  return {
    id, name: `p${id}`, isBot: id !== ME, island: id - 1, pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, hp: 100, shield: 0,
    alive: true, eliminated: false, kills: 0, deaths: 0, respawnAt: null, breakoutUntil: null, invulnUntil: 0, lastDamagedAt: 0,
    inv: { ...emptyInventory(), cash: 50 }, vault: emptyInventory(), locked: [], hotbar: Array(9).fill(null), selected: 0, equipped: 'fists', healAt: null, drinking: null, healLeft: 0, speedUntil: 0, reloadUntil: 0, reloadSec: 0, reloadMag: 0, nextFireAt: 0, busyUntil: 0, ads: false, bloom: 0, lastShotAt: -1e9, burst: 0, stamina: 100,
    ...extra,
  };
}
function snap(time: number, players: PlayerState[], events: [MatchEventType, Record<string, unknown>][] = []): Snapshot {
  return {
    time, tick: Math.round(time * 30), players, pieces: [], loot: [], projectiles: [], generators: [], genLevels: [1, 1, 1], sealed: [false, false, false], waterY: 0,
    suddenDeath: false, winner: null, potionShops: [], events: events.map(([type, data]): MatchEvent => ({ t: time, type, data })),
  };
}
/** 30 Hz: A circles (radius 6, 1 rad/s) so the path curves; ME stands. */
function frames(t0: number, t1: number, ev: (t: number) => [MatchEventType, Record<string, unknown>][] = () => []): Snapshot[] {
  const out: Snapshot[] = [];
  for (let i = Math.round(t0 * 30); i <= Math.round(t1 * 30); i++) {
    const t = i / 30;
    out.push(snap(t, [player(ME, { x: 0, y: 0, z: 0 }), player(A, { x: 6 * Math.cos(t), y: 0, z: 6 * Math.sin(t) }, { yaw: t })], ev(t)));
  }
  return out;
}

describe('killcam timing', () => {
  it('slow motion: 0.3× over the final shot(s), full speed away from it, eased in and out (no step)', () => {
    expect(SLOWMO).toBeGreaterThanOrEqual(0.25);
    expect(SLOWMO).toBeLessThanOrEqual(0.35);
    for (const lead of [SLOW_LEAD_MIN, 1, SLOW_LEAD_MAX]) {
      expect(timeScale(10, 10, lead)).toBeCloseTo(SLOWMO);
      expect(timeScale(10 - lead, 10, lead)).toBeCloseTo(SLOWMO); // held from the burst's first shot
      expect(timeScale(8, 10, lead)).toBe(1);
      expect(timeScale(11, 10, lead)).toBe(1);
      expect(slowAmount(10, 10, lead)).toBeCloseTo(1);
      // Real time spent at (nearly) the slowest speed: the held sim span, slowed.
      let held = 0;
      for (let t = 8; t < 11; t += 1 / 1000) if (timeScale(t, 10, lead) < SLOWMO + 0.02) held += (1 / 1000) / timeScale(t, 10, lead);
      expect(held).toBeGreaterThan((lead + 0.12) / SLOWMO);
      expect(held).toBeLessThan((lead + 0.3) / SLOWMO);
      let maxJump = 0;
      for (let t = 8; t < 11; t += 1 / 1000) maxJump = Math.max(maxJump, Math.abs(timeScale(t + 1 / 1000, 10, lead) - timeScale(t, 10, lead)));
      expect(maxJump).toBeLessThan(0.01);
    }
  });

  it('slow lead covers the final burst (clamped): one shot → minimum, a long burst → maximum', () => {
    expect(slowLead({ t: 10, burst: 10 })).toBe(SLOW_LEAD_MIN);
    expect(slowLead({ t: 10, burst: 9.4 })).toBeCloseTo(0.75);
    expect(slowLead({ t: 10, burst: 7 })).toBe(SLOW_LEAD_MAX);
  });

  it('a long burst on a short respawn wait: the slow lead shrinks to keep a full-speed lead-in', () => {
    const fs = frames(0, 10);
    const p = planKillcam(fs, 10, A, null, 9.9, SLOW_LEAD_MAX)!;
    expect(p.lead).toBeGreaterThan(SLOW_LEAD_MAX - 0.1); // (KILLCAM_SEC leaves room for nearly all of it)
    expect(realSpan(p.from, p.killT - p.lead - 0.25, p.killT, p.lead)).toBeGreaterThan(MIN_LEAD_IN - 0.05);
    const q = planKillcam(fs, 10, A, 5, 9.9, SLOW_LEAD_MAX)!;
    expect(q.lead).toBeLessThan(SLOW_LEAD_MAX);
    expect(q.real).toBeLessThanOrEqual(5 - RESPAWN_MARGIN + 1e-6);
  });

  it('total real length ≤ KILLCAM_SEC and inside the 10 s respawn wait, slow beat included', () => {
    const fs = frames(0, 10);
    const p = planKillcam(fs, 10, A, 9.8, 9.9)!;
    expect(p.real).toBeLessThanOrEqual(KILLCAM_SEC + 1e-6);
    expect(p.real).toBeLessThanOrEqual(9.8 - RESPAWN_MARGIN);
    expect(realSpan(p.from, p.to, p.killT, p.lead)).toBeCloseTo(p.real, 5);
    expect(p.killT).toBe(9.9);
    expect(p.from).toBeLessThan(p.killT - 1.5); // there's a lead-up to see
    // Short respawn: still fits.
    const q = planKillcam(fs, 10, A, 2.5, 9.9)!;
    expect(q.real).toBeLessThanOrEqual(2.5 - RESPAWN_MARGIN + 1e-6);
  });

  it('finds the killing shot: the last hit by the killer on the victim, and its shot line', () => {
    const fs = frames(0, 10, (t) => (Math.abs(t - 9.5) < 1e-6 ? [['shot', { by: A, from: { x: 1, y: 1.6, z: 0 }, to: { x: 0, y: 1.7, z: 0 } }], ['hit', { by: A, target: ME, part: 'head', pos: { x: 0, y: 1.7, z: 0 } }]]
      : Math.abs(t - 8) < 1e-6 ? [['hit', { by: A, target: ME, part: 'body' }]] : []));
    const k = findKillShot(fs, 10, A, ME);
    expect(k.t).toBeCloseTo(9.5);
    expect(k.headshot).toBe(true);
    expect(k.from).toEqual({ x: 1, y: 1.6, z: 0 });
    expect(k.to).toEqual({ x: 0, y: 1.7, z: 0 });
    expect(k.burst).toBeCloseTo(9.5); // the hit at 8 is 1.5 s earlier: not the same burst
    // No hit on record (debug kill, off-screen blast): the death is the beat.
    expect(findKillShot(frames(0, 10), 10, A, ME)).toEqual({ t: 10, from: null, to: null, headshot: false, burst: 10 });
  });
});

describe('killcam final burst', () => {
  it('a burst of shots (gaps ≤ 0.5 s) all count; a shot by someone else or an older one does not', () => {
    const at = (t: number, x: number) => Math.abs(t - x) < 1e-6;
    const fs = frames(0, 10, (t) => at(t, 9.6) ? [['shot', { by: A }], ['hit', { by: A, target: ME, part: 'body' }]]
      : at(t, 9.3) || at(t, 9) ? [['shot', { by: A }]]
      : at(t, 8.7) ? [['shot', { by: ME }]]
      : at(t, 8) ? [['shot', { by: A }]] : []);
    const k = findKillShot(fs, 10, A, ME);
    expect(k.t).toBeCloseTo(9.6);
    expect(k.burst).toBeCloseTo(9);
    expect(slowLead(k)).toBeCloseTo(0.75);
  });
});

describe('smooth player playback (sampleSmooth)', () => {
  const fs = frames(0, 2);
  it('exact at every recorded snapshot (no invented positions)', () => {
    for (const i of [3, 10, 40]) {
      const s = sampleSmooth(fs, i, 0, A)!;
      const p = fs[i].players.find((x) => x.id === A)!;
      expect(s.pos.x).toBeCloseTo(p.pos.x, 9);
      expect(s.pos.z).toBeCloseTo(p.pos.z, 9);
      expect(s.yaw).toBeCloseTo(p.yaw, 9);
    }
  });

  it('no velocity step at snapshot boundaries (linear interpolation steps every frame on a curve)', () => {
    let maxJump = 0;
    for (let i = 2; i < 50; i++) {
      const end = sampleSmooth(fs, i - 1, 1, A)!.vel;
      const ex = end.x, ez = end.z;
      const start = sampleSmooth(fs, i, 0, A)!.vel;
      maxJump = Math.max(maxJump, Math.hypot(start.x - ex, start.z - ez));
    }
    expect(maxJump).toBeLessThan(0.01);
    // Between frames it stays on the circle (true path) far better than the chord.
    const s = sampleSmooth(fs, 10, 0.5, A)!;
    expect(Math.abs(Math.hypot(s.pos.x, s.pos.z) - 6)).toBeLessThan(1e-3);
  });
});

// ---- the Killcam (skip / timing), with a tiny DOM stand-in ------------------------------------------

function fakeEl(): Record<string, unknown> {
  const e: Record<string, unknown> = {
    style: { setProperty() {}, display: '', opacity: '', transform: '' }, dataset: {}, className: '', textContent: '', innerHTML: '', title: '', childElementCount: 0,
    classList: { add() {}, remove() {} },
    append(...c: unknown[]) { (e.childElementCount as number) += c.length; }, prepend() {}, replaceChildren() { e.childElementCount = 0; },
  };
  return e;
}

describe('Killcam playback', () => {
  let Killcam: typeof import('../../src/client/qol/killcam').Killcam;
  let SKIP_GRACE: number;
  beforeAll(async () => {
    (globalThis as { document?: unknown }).document = { createElement: () => fakeEl(), createTextNode: () => ({}) };
    ({ Killcam, SKIP_GRACE } = await import('../../src/client/qol/killcam'));
  });
  const info = { killerName: 'Rex', island: 1, weapon: 'rifle', distance: 12, headshot: false, killerHp: 64, killerShield: 20 };

  function started() {
    const kc = new Killcam(fakeEl() as unknown as HTMLElement);
    for (const f of frames(0, 10.6)) kc.push(f);
    expect(kc.start(10, A, 9.8, info, 0, ME)).toBe(true);
    return kc;
  }

  it('plays for its planned real length (slow beat included), then ends by itself', () => {
    const kc = started();
    const plan = kc.last.plan!;
    let now = 0, frames = 0, slow = 0;
    while (kc.frame(now)) { frames++; now += 1000 / 120; const st = kc.info().stats; slow = st.slowFrames; }
    expect(kc.active).toBe(false);
    expect(kc.last.reason).toBe('ended');
    expect(now / 1000).toBeGreaterThan(plan.real - 0.1);
    expect(now / 1000).toBeLessThan(plan.real + 0.1);
    expect(now / 1000).toBeLessThanOrEqual(KILLCAM_SEC + 0.1);
    expect(slow).toBeGreaterThan(40); // ≥ ~0.35 s of frames in the slow beat at 120 fps
    expect(frames).toBeGreaterThan(400);
  });

  it('the impact fires exactly once, on the killing shot', () => {
    const kc = started();
    let now = 0, impacts = 0;
    for (let f = kc.frame(now); f; f = kc.frame(now)) { if (f.impact) impacts++; now += 1000 / 60; }
    expect(impacts).toBe(1);
  });

  it('camera moves smoothly frame to frame (no snaps)', () => {
    const kc = started();
    let now = 0;
    while (kc.frame(now)) now += 1000 / 120;
    // Players move ≤ 6 m/s here; the camera never jumps faster than a quick glide.
    expect(kc.info().stats.maxStep).toBeLessThan(25);
  });

  it('killer running past thin poles: the camera never snaps and never ends up inside one', () => {
    const kc = started();
    // Poles around the killer's circle (r = 6 about the victim), crossing the camera's line now and then.
    const poles: Box[] = [];
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 5) for (const r of [4, 7.5, 9]) {
      const x = r * Math.cos(a + r), z = r * Math.sin(a + r);
      poles.push(box(x - 0.12, -1, z - 0.12, x + 0.12, 6, z + 0.12));
    }
    const rc = boxRaycast(poles);
    let now = 0, occluded = 0;
    for (let f = kc.frame(now, rc), i = 0; f; f = kc.frame(now, rc), i++) {
      expect(inside(f.cam, poles), `frame ${i}`).toBe(false);
      const k = f.snap.players.find((p) => p.id === A)!;
      if (!sees(f.cam, chest(k.pos, SHOT.subjectChest), rc)) occluded++;
      now += 1000 / 60;
    }
    expect(occluded).toBeGreaterThan(0); // poles did pass between the camera and the killer (it used to pop in front of them)
    const st = kc.info().stats;
    expect(st.maxStep).toBeLessThan(25);
  });

  it('skip: ignored in the grace period (the press you died on), then any input skips at once', () => {
    const kc = started();
    kc.frame(0);
    kc.frame(100);
    expect(kc.trySkip(100)).toBe(false);
    expect(kc.active).toBe(true);
    kc.frame(SKIP_GRACE * 1000 + 50);
    expect(kc.trySkip(SKIP_GRACE * 1000 + 60)).toBe(true);
    expect(kc.active).toBe(false);
    expect(kc.last.reason).toBe('skipped');
    expect(kc.frame(SKIP_GRACE * 1000 + 80)).toBeNull();
  });
});

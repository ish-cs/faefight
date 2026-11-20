import { describe, expect, test } from 'vitest';
import { DT, PLAYER } from '../../src/sim/constants';
import { HitboxHistory, LAG_COMP, rayCapsule, rayPlayer } from '../../src/sim/lagComp';
import { buildMap } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { Physics } from '../../src/sim/physics';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type MatchEvent, type PlayerInput } from '../../src/sim/types';
import { norm, v3 } from '../../src/sim/vec';

const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

describe('lag compensation: geometry', () => {
  test('analytic capsule + headshot rule matches the Rapier player collider', async () => {
    const ph = await Physics.create(buildMap(2));
    const feet = v3(400, 30, 400); // far from every island
    ph.addPlayer(9, feet);
    const r = rng(1);
    let hits = 0, mismatches = 0, heads = 0;
    for (let i = 0; i < 2000; i++) {
      const o = v3(feet.x + (r() - 0.5) * 20, feet.y + r() * 4 - 1, feet.z + (r() - 0.5) * 20);
      const aim = v3(feet.x + (r() - 0.5) * 1.2, feet.y + r() * 2.1 - 0.1, feet.z + (r() - 0.5) * 1.2);
      const d = norm(v3(aim.x - o.x, aim.y - o.y, aim.z - o.z));
      const a = ph.raycast(o, d, 50);
      const b = rayPlayer(o, d, feet, 50);
      if (!!a !== !!b) { mismatches++; continue; }
      if (!a || !b) continue;
      hits++;
      expect(Math.abs(a.dist - b.dist)).toBeLessThan(2e-3);
      if (a.part !== b.part) mismatches++;
      if (b.part === 'head') heads++;
    }
    expect(hits).toBeGreaterThan(500);
    expect(heads).toBeGreaterThan(20);
    expect(mismatches).toBeLessThanOrEqual(4); // grazing rays only
  });

  test('a ray from inside the capsule hits at 0; rays above / beside miss', () => {
    const feet = v3(0, 0, 0);
    expect(rayCapsule(v3(0, 1, 0), v3(1, 0, 0), feet)).toBe(0);
    expect(rayCapsule(v3(-5, PLAYER.height + 0.05, 0), v3(1, 0, 0), feet)).toBeNull();
    expect(rayCapsule(v3(-5, 1, PLAYER.radius + 0.01), v3(1, 0, 0), feet)).toBeNull();
    expect(rayCapsule(v3(0, 5, 0), v3(0, -1, 0), feet)).toBeCloseTo(5 - PLAYER.height, 6);
  });
});

describe('lag compensation: hitbox history', () => {
  const at = (id: number, x: number, alive = true) => ({ ...newPlayer(id, 'p', false, 0, v3(x, 0, 0)), alive });
  test('interpolates between ticks, knows who was alive, keeps ~historySec, never blends teleports', () => {
    const h = new HitboxHistory();
    for (let i = 0; i <= 60; i++) h.record(i * DT, [at(1, i * 0.2), at(2, i < 50 ? 0 : 100), at(3, 0, i < 56)]);
    const out = v3();
    expect(h.at(55.5 * DT, 1, out)!.x).toBeCloseTo(11.1, 6);
    expect(h.at(49.6 * DT, 2, out)!.x).toBe(100); // teleport: nearer tick wins
    expect(h.at(49.4 * DT, 2, out)!.x).toBe(0);
    expect(h.at(55.5 * DT, 3, out)).toBeNull(); // died between these ticks
    expect(h.at(45 * DT, 3, out)).not.toBeNull();
    expect(h.oldest!).toBeGreaterThanOrEqual(60 * DT - LAG_COMP.historySec - DT);
    expect(LAG_COMP.historySec).toBeGreaterThanOrEqual(0.3);
    expect(h.at(0, 1, out)).toBeNull(); // fell out of the window
  });
});

/** Two humans on island 0: #1 holds an aimed-down rifle, #2 strafes across its line of fire at 6 m/s. */
async function duel() {
  const m = await Match.create({ players: [{ name: 'shooter', isBot: false }, { name: 'target', isBot: false }], seed: 3 });
  const isl = m.map[0];
  const shooterFeet = v3(isl.center.x - 4, isl.groundY, isl.center.z + 3);
  m.debugTeleport(1, shooterFeet);
  m.debugGive(1, { weapons: { rifle: { mag: 25, spare: 100 } } });
  let snap = m.tick(new Map());
  const slot = snap.players[0].hotbar.indexOf('rifle');
  const targetAt = (t: number) => v3(isl.center.x + 6, isl.groundY, isl.center.z + 3 + (t - 1) * 6);
  const events: MatchEvent[] = [];
  /** Advance to sim time ~1 s with the target strafing; returns per-tick (time, target feet). */
  const run = (until: number, fire?: (now: number) => PlayerInput | null) => {
    for (;;) {
      const now = snap.time + DT;
      if (now > until + 1e-9) return;
      m.debugTeleport(2, targetAt(now));
      const inp = fire?.(now) ?? { ...NO_INPUT, select: slot, ads: true };
      snap = m.tick(new Map([[1, inp]]));
      events.push(...snap.events);
    }
  };
  /** Input aiming #1's eye at #2's chest as it stood at time t. */
  const aimAt = (t: number, viewT?: number): PlayerInput => {
    const eye = v3(shooterFeet.x, shooterFeet.y + PLAYER.eyeHeight, shooterFeet.z);
    const c = targetAt(t);
    const dx = c.x - eye.x, dy = c.y + 1.2 - eye.y, dz = c.z - eye.z;
    return { ...NO_INPUT, select: slot, ads: true, fire: true, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), ...(viewT !== undefined ? { viewT } : {}) };
  };
  const hitsOn2 = () => events.filter((e) => e.type === 'hit' && e.data.target === 2 && e.data.by === 1);
  return { m, run, aimAt, hitsOn2, events, targetAt, get snap() { return snap; } };
}

describe('lag compensation: rewound hitscan', () => {
  test('a shot that hit on the client screen at 120 ms RTT registers (and misses without rewind)', async () => {
    // Client view: 60 ms one-way + ~60 ms interpolation delay behind the host.
    for (const lagComp of [true, false]) {
      const d = await duel();
      d.run(1.0);
      const fireAt = d.snap.time + DT;
      const seen = fireAt - 0.12;
      d.run(fireAt, (now) => (now >= fireAt - 1e-9 ? d.aimAt(seen, lagComp ? seen : undefined) : null));
      expect(d.events.some((e) => e.type === 'shot' && e.data.by === 1)).toBe(true);
      expect(d.hitsOn2().length).toBe(lagComp ? 1 : 0);
      if (lagComp) expect(d.m.lagStats.shots).toBe(1);
    }
  });

  test('headshots survive the rewind', async () => {
    const d = await duel();
    d.run(1.0);
    const fireAt = d.snap.time + DT, seen = fireAt - 0.1;
    d.run(fireAt, (now) => {
      if (now < fireAt - 1e-9) return null;
      const inp = d.aimAt(seen, seen);
      // Raise the aim from the chest (1.2 m) to the head centre (HEAD.y = 1.62 m) at ~10 m.
      const c = d.targetAt(seen);
      const p0 = d.snap.players[0].pos;
      inp.pitch = Math.atan2(c.y + 1.62 - (p0.y + PLAYER.eyeHeight), Math.hypot(c.x - p0.x, c.z - p0.z));
      return inp;
    });
    const hits = d.hitsOn2();
    expect(hits).toHaveLength(1);
    expect(hits[0].data.part).toBe('head');
  });

  test('rewind is clamped to maxRewindSec: a claim of 1 s ago does not hit where the target was 1 s ago', async () => {
    const d = await duel();
    d.run(1.5);
    const fireAt = d.snap.time + DT, seen = fireAt - 1.0;
    d.run(fireAt, (now) => (now >= fireAt - 1e-9 ? d.aimAt(seen, seen) : null));
    expect(d.hitsOn2()).toHaveLength(0);
    expect(d.m.lagStats.rewindSec).toBeLessThanOrEqual(LAG_COMP.maxRewindSec + 1e-9);
  });

  test('a viewT in the future resolves against the last finished tick (nothing newer was ever shown)', async () => {
    const d = await duel();
    d.run(1.0);
    const last = d.snap.time, fireAt = last + DT;
    d.run(fireAt, (now) => (now >= fireAt - 1e-9 ? d.aimAt(last, fireAt + 5) : null));
    expect(d.m.lagStats.rewindSec).toBeCloseTo(DT, 6);
    expect(d.hitsOn2()).toHaveLength(1);
  });

  test('garbage viewT means no rewind', async () => {
    const d = await duel();
    d.run(1.0);
    const fireAt = d.snap.time + DT;
    d.run(fireAt, (now) => (now >= fireAt - 1e-9 ? { ...d.aimAt(fireAt), viewT: NaN } : null));
    expect(d.m.lagStats.shots).toBe(0);
    expect(d.hitsOn2()).toHaveLength(1); // aimed at where it is now: plain hit
  });
});

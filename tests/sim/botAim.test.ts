import { describe, expect, test } from 'vitest';
import { AIM, Aim, wrapAngle, type Angles } from '../../src/sim/bots/aim';
import { aimStats, type AimSample } from '../../src/sim/bots/aimStats';
import { AIM_PARAMS, GUN_SKILL } from '../../src/sim/bots/params';
import { DT } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import { mulberry32 } from '../../src/sim/rng';
import type { Difficulty } from '../../src/sim/types';

const TIERS: Difficulty[] = ['easy', 'medium', 'hard', 'pro'];
const DEG = Math.PI / 180;

describe('bot aim hand (Aim.look)', () => {
  test.each(TIERS)('%s: a 90° flick eases in, stays under the speed/acceleration caps and settles', (d) => {
    const aim = new Aim({ ...AIM[d], recoilComp: GUN_SKILL[d].recoilComp }, mulberry32(1), AIM_PARAMS.feel[d]);
    const want: Angles = { yaw: Math.PI / 2, pitch: 0 };
    let cur: Angles = { yaw: 0, pitch: 0 }, prevV = 0, peak = 0;
    const settleBy = d === 'pro' || d === 'hard' ? 0.5 : 1.2;
    for (let i = 1; i <= 60; i++) {
      const next = aim.look(cur, want, DT, AIM[d].maxTurn);
      const v = wrapAngle(next.yaw - cur.yaw) / DT;
      expect(Math.abs(v)).toBeLessThanOrEqual(AIM[d].maxTurn + 1e-9);
      expect(Math.abs(v - prevV) / DT).toBeLessThanOrEqual(AIM_PARAMS.feel[d].maxAccel + 1e-6);
      peak = Math.max(peak, next.yaw);
      prevV = v; cur = next;
      if (i * DT >= settleBy) expect(Math.abs(cur.yaw - want.yaw), `${d} settled at ${(i * DT).toFixed(2)} s`).toBeLessThan(1.5 * DEG);
    }
    const overshoot = (peak - want.yaw) / DEG;
    if (d === 'pro') { expect(overshoot).toBeGreaterThan(0.2); expect(overshoot).toBeLessThan(8); } // a flick with a little overshoot
    else expect(overshoot).toBeLessThan(8);
  });

  test('aim error drifts smoothly (low-frequency), not tick-to-tick noise', () => {
    const aim = new Aim({ ...AIM.hard, recoilComp: GUN_SKILL.hard.recoilComp }, mulberry32(7), AIM_PARAMS.feel.hard);
    const eye = { x: 0, y: 1.6, z: 0 }, target = { x: 0, y: 1.6, z: -20 };
    let cur: Angles = { yaw: 0, pitch: 0 };
    const offs: number[] = [];
    for (let i = 0; i < 30 * 20; i++) {
      cur = aim.track(i * DT, DT, eye, target, 2, cur);
      if (i > 30) offs.push(cur.yaw);
    }
    const steps = offs.slice(1).map((y, i) => Math.abs(y - offs[i]));
    const spread = Math.max(...offs) - Math.min(...offs);
    // Wanders over a good part of the cone…
    expect(spread).toBeGreaterThan(0.5 * AIM.hard.coneRad);
    // …but each tick moves only a sliver of that, and tick-to-tick steps change direction rarely.
    expect(Math.max(...steps)).toBeLessThan(0.12 * AIM.hard.coneRad);
    let flips = 0;
    for (let i = 2; i < offs.length; i++) if (Math.sign(offs[i] - offs[i - 1]) !== Math.sign(offs[i - 1] - offs[i - 2])) flips++;
    expect(flips / (offs.length * DT)).toBeLessThan(6); // white noise would flip ~15 times a second
  });
});

/** 8-bot mixed FFA: each player's view per tick. */
async function viewTracks(seed: number, secs: number) {
  const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'];
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  const tracks = new Map<number, AimSample[]>();
  let snap = m.tick(new Map());
  for (let i = 0; i < secs / DT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const p of snap.players) {
      if (!tracks.has(p.id)) tracks.set(p.id, []);
      tracks.get(p.id)!.push({ yaw: p.yaw, pitch: p.pitch, alive: p.alive });
    }
  }
  return { diffs, tracks };
}

describe('bot view in a match (spectating feels human)', () => {
  test('no flick-backs, no snaps: reversals, jerks and peak turn speed stay human across tiers', async () => {
    const { diffs, tracks } = await viewTracks(1, 150);
    for (const d of TIERS) {
      const mine = [...tracks].filter(([id]) => diffs[id - 1] === d).map(([, t]) => t);
      const s = aimStats(mine, DT);
      const msg = `${d}: ${JSON.stringify(s)}`;
      expect(s.aliveSec, msg).toBeGreaterThan(100);
      // Before: ~0.2–0.4 reversals/s, ~0.1–0.36 fast flick-backs/s, peaks of 2700–5100°/s (whole-turn snaps).
      expect(s.reversalsPerSec, msg).toBeLessThan(0.15);
      expect(s.flickBacksPerSec, msg).toBeLessThan(0.03);
      expect(s.spikesPerSec, msg).toBeLessThan(0.03);
      expect(s.max, msg).toBeLessThanOrEqual(Math.max(AIM[d].maxTurn, 8) / DEG + 1); // never faster than a hand (or the walk turn)
    }
  }, 120_000);

  test('deterministic: the same seed gives the same view track', async () => {
    const a = await viewTracks(5, 40), b = await viewTracks(5, 40);
    expect([...b.tracks]).toEqual([...a.tracks]);
  }, 120_000);
});

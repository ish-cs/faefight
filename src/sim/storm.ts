import { applyPlayerDamage, type CombatCtx } from './combat';
import { MAP, STORM } from './constants';
import type { IslandLayout } from './map';
import type { MatchEvent, StormSnap, StormStrike } from './types';

/**
 * Sudden-death storm (tuning and rules in constants.STORM). Everything here is a pure function of the
 * match seed and sim state: strike placement draws from the storm's own seeded stream, whose state lives in
 * StormState so a copied match (replay seeking) continues identically.
 */
export type StormState = {
  startAt: number;
  cx: number;
  cz: number;
  /** Radius at startAt (beyond the map edge), and the final circle it holds after shrinkSec. */
  r0: number;
  rf: number;
  /** mulberry32 state of the strike stream. */
  rng: number;
  nextDamageAt: number;
  /** When the next strike lands (it is announced telegraphSec before). */
  nextStrikeAt: number;
  /** Announced strikes that haven't landed yet. */
  strikes: StormStrike[];
};

/** Where the ring closes in: the centre island (`r` = its land radius; 0 = open water, e.g. bare test maps). */
export type StormCenter = { x: number; z: number; r: number };

export function stormCenterOf(center: { center: { x: number; z: number }; radius: number } | null): StormCenter {
  return center ? { x: center.center.x, z: center.center.z, r: center.radius } : { x: 0, z: 0, r: 0 };
}

export function stormStartRadius(map: IslandLayout[], c: StormCenter): number {
  return Math.max(c.r, ...map.map((i) => Math.hypot(i.center.x - c.x, i.center.z - c.z) + i.radius)) + STORM.startPad;
}

/** The final circle: small, but always holding all of the centre island's land with a margin. */
export function stormFinalRadius(c: StormCenter): number {
  return Math.max(STORM.finalRadius, c.r + STORM.finalPad);
}

/** Linear close from r0 to the final circle over shrinkSec, then hold. */
export function stormRadius(st: Pick<StormState, 'r0' | 'rf' | 'startAt'>, now: number): number {
  const k = Math.min(1, Math.max(0, (now - st.startAt) / STORM.shrinkSec));
  return st.r0 + (st.rf - st.r0) * k;
}

/** Storm hp loss per second outside the ring, t s into it. */
export function stormDps(t: number): number {
  return Math.min(STORM.dpsMax, STORM.dps0 + STORM.dpsRamp * Math.max(0, t));
}

export function newStorm(map: IslandLayout[], c: StormCenter, startAt: number, seed: number): StormState {
  return {
    startAt, cx: c.x, cz: c.z, r0: stormStartRadius(map, c), rf: stormFinalRadius(c),
    rng: (Math.imul(seed | 0, 0x9e3779b1) ^ 0x51f15e) >>> 0,
    nextDamageAt: startAt + 1, nextStrikeAt: startAt + 3, strikes: [],
  };
}

/** One draw from the storm's mulberry32 stream. */
function rand(st: StormState): number {
  st.rng = (st.rng + 0x6d2b79f5) >>> 0;
  let t = st.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Announce a strike (tests/debug: an exact spot; the storm itself uses placeStrike). */
export function addStrike(st: StormState, x: number, z: number, at: number): void {
  st.strikes.push({ x: r2(x), z: r2(z), at: r3(at) });
}

function placeStrike(ctx: CombatCtx, st: StormState, at: number): void {
  const r = stormRadius(st, at);
  const ring = (d: number, a: number) => addStrike(st, st.cx + Math.cos(a) * d, st.cz + Math.sin(a) * d, at);
  if (rand(st) < STORM.edgeStrikeFrac) {
    // Pressure on whoever hugs the edge: just inside the ring.
    ring(Math.max(0, r - 0.5 - rand(st) * (STORM.edgeStrikeDepth - 0.5)), rand(st) * Math.PI * 2);
    return;
  }
  const out = [...ctx.players.values()].filter((p) => p.alive && Math.hypot(p.pos.x - st.cx, p.pos.z - st.cz) > r);
  if (out.length && rand(st) < STORM.playerStrikeFrac) {
    // Near someone standing in the storm (never on top of them: the telegraph gives them a chance).
    const p = out[Math.min(out.length - 1, Math.floor(rand(st) * out.length))];
    const a = rand(st) * Math.PI * 2, off = 1.5 + rand(st) * 3.5;
    addStrike(st, p.pos.x + Math.cos(a) * off, p.pos.z + Math.sin(a) * off, at);
    return;
  }
  ring(r + 1 + rand(st) * STORM.zoneDepth, rand(st) * Math.PI * 2);
}

/** One sim tick of the storm: ring damage (once a second), announcing and landing lightning. */
export function tickStorm(ctx: CombatCtx, st: StormState, now: number): MatchEvent[] {
  const out: MatchEvent[] = [];
  const r = stormRadius(st, now);

  if (now >= st.nextDamageAt) {
    st.nextDamageAt = now + 1;
    const dmg = stormDps(now - st.startAt);
    for (const p of ctx.players.values())
      if (p.alive && Math.hypot(p.pos.x - st.cx, p.pos.z - st.cz) > r)
        out.push(...applyPlayerDamage(ctx, p, dmg, null, now, { bypassShield: true, weapon: 'storm' }));
  }

  // A jump in time (debug) doesn't unleash a backlog of strikes.
  if (st.nextStrikeAt < now + 0.1) st.nextStrikeAt = now + STORM.telegraphSec;
  while (now >= st.nextStrikeAt - STORM.telegraphSec) {
    const at = st.nextStrikeAt;
    placeStrike(ctx, st, at);
    const k = Math.min(1, (at - st.startAt) / STORM.shrinkSec);
    const gap = STORM.strikeGap + (STORM.strikeGapMin - STORM.strikeGap) * k;
    st.nextStrikeAt = at + gap * (0.6 + 0.8 * rand(st));
  }

  const landed = st.strikes.filter((s) => now >= s.at);
  if (landed.length) st.strikes = st.strikes.filter((s) => now < s.at);
  for (const s of landed) {
    const y = ctx.physics.isGroundAt(s.x, s.z) ?? MAP.waterY;
    out.push({ t: now, type: 'lightning', data: { pos: { x: s.x, y: r2(y), z: s.z } } });
    for (const p of ctx.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.pos.x - s.x, p.pos.z - s.z);
      if (d < STORM.boltRadius)
        out.push(...applyPlayerDamage(ctx, p, STORM.boltDmg * (1 - d / STORM.boltRadius), null, now, { bypassShield: true, weapon: 'lightning', pos: { x: s.x, y, z: s.z } }));
    }
  }
  return out;
}

export function stormSnap(st: StormState, now: number): StormSnap {
  return { x: st.cx, z: st.cz, r: r2(stormRadius(st, now)), rf: r2(st.rf), strikes: st.strikes.map((s) => ({ ...s })) };
}

/** How fast the ring is closing right now (m/s; 0 once it holds the final circle). */
export function stormRate(st: StormState, now: number): number {
  return now - st.startAt < STORM.shrinkSec ? (st.r0 - st.rf) / STORM.shrinkSec : 0;
}

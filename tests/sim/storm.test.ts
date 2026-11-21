import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { buildMap } from '../../src/sim/map';
import { LIFECYCLE, MAP, PLAYER, STORM } from '../../src/sim/constants';
import { stormRadius, stormStartRadius, stormCenter } from '../../src/sim/storm';
import { dist2D, v3 } from '../../src/sim/vec';
import type { Difficulty, MatchEvent, Snapshot } from '../../src/sim/types';

const SD = LIFECYCLE.suddenDeathAt;
const humans = (seed = 3) => Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }], seed });
const run = (m: Match, sec: number) => {
  const evs: MatchEvent[] = [];
  let snap!: Snapshot;
  for (let i = 0; i < Math.round(sec * 30); i++) { snap = m.tick(new Map()); evs.push(...snap.events); }
  return { snap, evs };
};
const center = stormCenter(buildMap(2));

describe('storm ring', () => {
  test('starts beyond the map edge, shrinks over ~3 min, then holds the final circle', () => {
    for (const n of [2, 5, 8]) {
      const map = buildMap(n);
      const r0 = stormStartRadius(map);
      const edge = Math.max(...map.map((i) => Math.hypot(i.center.x - center.x, i.center.z - center.z) + i.radius));
      expect(r0).toBeGreaterThan(edge);
      expect(stormRadius(r0, SD, SD)).toBeCloseTo(r0);
      expect(stormRadius(r0, SD, SD + STORM.shrinkSec / 2)).toBeCloseTo((r0 + STORM.finalRadius) / 2);
      expect(stormRadius(r0, SD, SD + STORM.shrinkSec)).toBeCloseTo(STORM.finalRadius);
      expect(stormRadius(r0, SD, SD + STORM.shrinkSec + 300)).toBeCloseTo(STORM.finalRadius);
    }
    expect(STORM.shrinkSec).toBeGreaterThanOrEqual(150);
    expect(STORM.shrinkSec).toBeLessThanOrEqual(210);
  });

  test('no storm before sudden death; at 15:00 it starts, bunkers force-seal, the water stays put', async () => {
    const m = await humans();
    m.debugSetTime(SD - 1);
    let { snap, evs } = run(m, 0.5);
    expect(snap.suddenDeath).toBe(false);
    expect(snap.storm ?? null).toBeNull();
    ({ snap, evs } = run(m, 10));
    expect(snap.suddenDeath).toBe(true);
    expect(evs.some((e) => e.type === 'suddenDeath')).toBe(true);
    expect(snap.sealed).toEqual([true, true]);
    expect(snap.waterY).toBe(MAP.waterY);
    expect(snap.storm!.r).toBeCloseTo(stormRadius(stormStartRadius(m.map), SD, snap.time), 1);
    expect([snap.storm!.x, snap.storm!.z]).toEqual([center.x, center.z]);
    ({ snap } = run(m, 120));
    expect(snap.waterY).toBe(MAP.waterY);
  });
});

/** 2 players: island 0 centre (-40, 0), island 1 centre (40, 0). Ring at SD+120 s is ~34 m. */
async function outsideInside(seed = 3) {
  const m = await humans(seed);
  m.debugSetTime(SD + 120);
  m.debugTeleport(1, v3(-40, MAP.groundY, 10)); // ~41 m out: in the storm
  m.debugTeleport(2, v3(24, MAP.groundY, 0)); // 24 m out: safe
  return m;
}

describe('storm damage', () => {
  test('hurts players outside the ring, not inside, and goes straight to hp (shield untouched)', async () => {
    const m = await outsideInside();
    m.debugSetShield(1, 50);
    m.debugSetShield(2, 50);
    const { snap, evs } = run(m, 4);
    const r = snap.storm!.r;
    expect(r).toBeGreaterThan(30);
    expect(r).toBeLessThan(41);
    const storm = evs.filter((e) => e.type === 'hit' && e.data.weapon === 'storm');
    expect(storm.length).toBeGreaterThanOrEqual(3);
    expect(storm.every((e) => e.data.target === 1 && e.data.shieldAmount === 0 && (e.data.amount as number) > 0)).toBe(true);
    const a = snap.players.find((p) => p.id === 1)!, b = snap.players.find((p) => p.id === 2)!;
    const bolts = (id: number) => evs.filter((e) => e.type === 'hit' && e.data.weapon === 'lightning' && e.data.target === id);
    expect(a.hp).toBeLessThan(PLAYER.hp);
    if (!bolts(1).length) expect(a.shield).toBe(50);
    if (!bolts(2).length) { expect(b.hp).toBe(PLAYER.hp); expect(b.shield).toBe(50); }
  });

  test('the damage ramps up the longer the storm runs', async () => {
    const at = async (t: number) => {
      const m = await humans();
      m.debugSetTime(t);
      m.debugTeleport(1, v3(-40, MAP.groundY, 10));
      m.debugSetHp(1, 100);
      const { evs } = run(m, 2.1);
      const hits = evs.filter((e) => e.type === 'hit' && e.data.weapon === 'storm' && e.data.target === 1);
      return Math.max(...hits.map((e) => e.data.amount as number));
    };
    const early = await at(SD + 100), late = await at(SD + 200);
    expect(late).toBeGreaterThan(early * 1.5);
  });

  test('a storm death is a death with no killer and cause "storm"', async () => {
    const m = await outsideInside();
    m.debugSetHp(1, 1);
    const { evs } = run(m, 1.1);
    const kill = evs.find((e) => e.type === 'kill' && e.data.victim === 1);
    expect(kill?.data).toMatchObject({ killer: null, cause: 'storm' });
  });
});

describe('lightning', () => {
  test('a telegraphed strike hurts players near it, never building pieces', async () => {
    const m = await outsideInside();
    const p2 = v3(24, MAP.groundY, 0);
    const piece = m.debugPlacePiece('wood', v3(p2.x + 1.2, MAP.groundY, p2.z), 0);
    const before = run(m, 0.1).snap;
    const hp0 = before.pieces.find((p) => p.id === piece)!.hp;
    m.debugStrike(p2.x + 0.5, p2.z);
    const { snap: shown } = run(m, 0.1);
    // Telegraph: the strike is in the snapshot ~1 s before it lands.
    const s = shown.storm!.strikes.find((k) => Math.abs(k.x - (p2.x + 0.5)) < 0.01);
    expect(s).toBeTruthy();
    expect(s!.at - shown.time).toBeGreaterThan(STORM.telegraphSec - 0.25);
    const { snap, evs } = run(m, STORM.telegraphSec + 0.2);
    expect(evs.some((e) => e.type === 'lightning')).toBe(true);
    const hit = evs.find((e) => e.type === 'hit' && e.data.weapon === 'lightning' && e.data.target === 2);
    expect(hit).toBeTruthy();
    expect(snap.players.find((p) => p.id === 2)!.hp).toBeLessThan(PLAYER.hp);
    expect(snap.pieces.find((p) => p.id === piece)!.hp).toBe(hp0);
    expect(evs.some((e) => e.type === 'pieceHit' || e.type === 'destroyed')).toBe(false);
  });

  test('strikes keep falling during the storm, in the storm or just inside the ring edge, and never damage pieces', async () => {
    const m = await humans();
    m.debugSetTime(SD);
    for (let i = 0; i < 40; i++) m.debugPlacePiece('wood', v3(-40 + (i % 8) * 3, MAP.groundY, -12 + Math.floor(i / 8) * 3), 0);
    const strikes: { x: number; z: number; t: number; r: number }[] = [];
    let hits = 0;
    for (let i = 0; i < 30 * 200; i++) {
      const snap = m.tick(new Map());
      for (const e of snap.events) {
        if (e.type === 'lightning') { const p = e.data.pos as { x: number; z: number }; strikes.push({ x: p.x, z: p.z, t: e.t, r: snap.storm!.r }); }
        if (e.type === 'pieceHit' || e.type === 'destroyed') hits++;
      }
    }
    expect(strikes.length).toBeGreaterThan(60);
    expect(hits).toBe(0);
    const d = strikes.map((s) => Math.hypot(s.x - center.x, s.z - center.z) - s.r);
    expect(d.every((x) => x > -STORM.edgeStrikeDepth - 0.5)).toBe(true);
    expect(d.filter((x) => x < 0).length).toBeGreaterThan(0); // some pressure just inside the edge
    expect(d.filter((x) => x > 0).length).toBeGreaterThan(d.filter((x) => x < 0).length);
  }, 60_000);

  test('deterministic: the same seed gives the same strikes, another seed different ones', async () => {
    const strikes = async (seed: number) => {
      const m = await humans(seed);
      m.debugSetTime(SD - 0.1);
      const out: string[] = [];
      for (let i = 0; i < 30 * 60; i++) {
        const snap = m.tick(new Map());
        for (const s of snap.storm?.strikes ?? []) out.push(`${s.x.toFixed(3)},${s.z.toFixed(3)},${s.at.toFixed(3)}`);
        for (const e of snap.events) if (e.type === 'lightning') out.push(JSON.stringify(e.data));
      }
      return out;
    };
    const a = await strikes(11), b = await strikes(11), c = await strikes(12);
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  }, 60_000);
});

describe('bots and the storm', () => {
  test.each(['medium', 'hard', 'pro'] as Difficulty[])('%s bots get inside the ring ahead of it and stay there', async (difficulty) => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty }, { name: 'b', isBot: true, difficulty }], seed: 5 });
    run(m, 1);
    // Ring at SD+90 s ~ 44 m: the bunkers (55 m out) are in the storm, the island middles (40 m) just inside.
    m.debugSetTime(SD + 90);
    let { snap } = run(m, 25);
    let outside = 0;
    for (let i = 0; i < 20; i++) {
      ({ snap } = run(m, 0.5));
      for (const p of snap.players) if (p.alive && dist2D(p.pos, v3(center.x, 0, center.z)) > snap.storm!.r) outside++;
    }
    const alive = snap.players.filter((p) => p.alive);
    expect(alive.length).toBeGreaterThan(0);
    for (const p of alive) expect(dist2D(p.pos, v3(center.x, 0, center.z)), `${difficulty} bot ${p.id}`).toBeLessThan(snap.storm!.r - 1);
    expect(outside).toBeLessThanOrEqual(2);
  }, 120_000);

  test('a bot steps away from a telegraphed strike on top of it', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'hard' }, { name: 'b', isBot: false }], seed: 5 });
    run(m, 1);
    m.debugSetTime(SD + 90);
    run(m, 20);
    let { snap } = run(m, 0.1);
    const me = snap.players.find((p) => p.id === 1)!;
    m.debugStrike(me.pos.x, me.pos.z);
    ({ snap } = run(m, STORM.telegraphSec - 0.1));
    const now = snap.players.find((p) => p.id === 1)!;
    expect(dist2D(now.pos, me.pos)).toBeGreaterThan(STORM.boltRadius * 0.6);
  }, 60_000);
});

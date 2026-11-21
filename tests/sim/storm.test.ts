import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { buildMapDef } from '../../src/sim/map';
import { LIFECYCLE, MAP, PLAYER, STORM } from '../../src/sim/constants';
import { newStorm, stormCenterOf, stormFinalRadius, stormRadius, stormStartRadius } from '../../src/sim/storm';
import { dist2D, v3 } from '../../src/sim/vec';
import type { Difficulty, MatchEvent, Snapshot } from '../../src/sim/types';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SD = LIFECYCLE.suddenDeathAt;
const humans = (seed = 3) => Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }], seed });
const run = (m: Match, sec: number) => {
  const evs: MatchEvent[] = [];
  let snap!: Snapshot;
  for (let i = 0; i < Math.round(sec * 30); i++) { snap = m.tick(new Map()); evs.push(...snap.events); }
  return { snap, evs };
};
/** 1v1 harbor: islands at (±40, 0), the center island off to the side at (0, 30), radius 10. */
const def2 = buildMapDef(2);
const center = stormCenterOf(def2.center);
const ring = (sd: number, map = def2) => newStorm(map.islands, stormCenterOf(map.center), sd, 1);

describe('storm ring', () => {
  test('centred on the center island; starts beyond the map edge, shrinks over ~3 min, holds a final circle over the island', () => {
    for (const template of ['harbor', 'yard'] as const) for (const n of [2, 3, 5, 8]) {
      const def = buildMapDef(n, template);
      const c = stormCenterOf(def.center);
      expect([c.x, c.z, c.r]).toEqual([def.center.center.x, def.center.center.z, def.center.radius]);
      const st = ring(SD, def);
      const edge = Math.max(...def.islands.map((i) => Math.hypot(i.center.x - c.x, i.center.z - c.z) + i.radius));
      expect(st.r0).toBe(stormStartRadius(def.islands, c));
      expect(st.r0).toBeGreaterThan(edge);
      const rf = stormFinalRadius(c);
      // Small, but all of the center island's land is inside it (so it's always reachable by bridge).
      expect(rf).toBeGreaterThanOrEqual(def.center.radius + 2);
      expect(rf).toBeLessThan(def.center.radius + 8);
      expect(stormRadius(st, SD)).toBeCloseTo(st.r0);
      expect(stormRadius(st, SD + STORM.shrinkSec / 2)).toBeCloseTo((st.r0 + rf) / 2);
      expect(stormRadius(st, SD + STORM.shrinkSec)).toBeCloseTo(rf);
      expect(stormRadius(st, SD + STORM.shrinkSec + 300)).toBeCloseTo(rf);
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
    expect(snap.storm!.r).toBeCloseTo(stormRadius(ring(SD), snap.time), 1);
    expect(snap.storm!.rf).toBe(stormFinalRadius(center));
    expect([snap.storm!.x, snap.storm!.z]).toEqual([center.x, center.z]);
    ({ snap } = run(m, 120));
    expect(snap.waterY).toBe(MAP.waterY);
  });
});

/** Ring at SD+120 s is ~37 m around (0, 30): (-40, 0) is 50 m out, (24, 12) is 30 m out on island 1. */
const OUT = v3(-40, MAP.groundY, 0), IN = v3(24, MAP.groundY, 12);
async function outsideInside(seed = 3) {
  const m = await humans(seed);
  m.debugSetTime(SD + 120);
  m.debugTeleport(1, OUT); // in the storm
  m.debugTeleport(2, IN); // safe
  return m;
}

describe('storm damage', () => {
  test('hurts players outside the ring, not inside, and goes straight to hp (shield untouched)', async () => {
    const m = await outsideInside();
    m.debugSetShield(1, 50);
    m.debugSetShield(2, 50);
    const { snap, evs } = run(m, 4);
    const r = snap.storm!.r;
    expect(r).toBeGreaterThan(31);
    expect(r).toBeLessThan(49);
    const storm = evs.filter((e) => e.type === 'hit' && e.data.weapon === 'storm');
    expect(storm.length).toBeGreaterThanOrEqual(3);
    expect(storm.every((e) => e.data.target === 1 && e.data.shieldAmount === 0 && (e.data.amount as number) > 0)).toBe(true);
    const a = snap.players.find((p) => p.id === 1)!, b = snap.players.find((p) => p.id === 2)!;
    const bolts = (id: number) => evs.filter((e) => e.type === 'hit' && e.data.weapon === 'lightning' && e.data.target === id);
    expect(a.hp).toBeLessThan(PLAYER.hp);
    // Storm and lightning both go straight to hp: shields untouched either way.
    expect(a.shield).toBe(50);
    expect(b.shield).toBe(50);
    if (!bolts(2).length) expect(b.hp).toBe(PLAYER.hp);
  });

  test('the damage ramps up the longer the storm runs', async () => {
    const at = async (t: number) => {
      const m = await humans();
      m.debugSetTime(t);
      m.debugTeleport(1, OUT);
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
  test('a telegraphed strike hurts players near it straight to hp (shield untouched), never building pieces', async () => {
    const m = await outsideInside();
    m.debugSetShield(2, 50);
    const p2 = IN;
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
    expect(hit!.data.shieldAmount).toBe(0);
    expect(snap.players.find((p) => p.id === 2)!.shield).toBe(50);
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
    // Ring at SD+90 s ~49 m: the bunkers (~63 m out) are in the storm; the islands' near halves are inside.
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

describe('8 bots and the storm', () => {
  // 8 players: the islands sit ~80 m from the center island, so the only land inside the late ring is the
  // center island. Medium+ bots bridge there ahead of the storm instead of dying to it on their shore.
  // Everyone left in the final ring is a rival: the endgame always resolves before the cap. Medium 5/6/9 used to
  // end with 2-4 bots idling there (an empty mag never got reloaded with an enemy in sight; out of ammo they
  // wouldn't punch). Seed 7 exercises the bridge-to-center path.
  // Seed sweep: STORM_SEEDS=1-20 (medium) widens it, e.g. for a series.
  const range = (env.STORM_SEEDS ?? '1-9').split(',').flatMap((r) => {
    const [a, b] = r.split('-').map(Number);
    return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
  });
  test.each([...range.map((s) => ['medium', s]), ['hard', 5]] as [Difficulty, number][])('%s seed %i: the survivor ends inside the ring, nobody lost to the storm on the shore', async (difficulty, seed) => {
    const m = await Match.create({ players: Array.from({ length: 8 }, (_, i) => ({ name: `b${i}`, isBot: true, difficulty })), seed });
    run(m, 1);
    for (let id = 1; id <= 8; id++) m.debugGive(id, { cash: 800 }); // what they'd have earned by 12:30
    m.debugSetTime(SD - 160);
    const c = m.def.center;
    let snap = m.tick(new Map());
    let stormKills = 0;
    for (let i = 0; i < 30 * 420 && snap.winner === null; i++) {
      snap = m.tick(new Map());
      for (const e of snap.events) if (e.type === 'kill' && e.data.cause === 'storm') stormKills++;
    }
    expect(snap.winner, 'match ended').not.toBeNull();
    expect(stormKills).toBeLessThanOrEqual(1);
    const w = snap.players.find((p) => p.id === snap.winner)!;
    expect(w.alive).toBe(true);
    expect(Math.hypot(w.pos.x - c.center.x, w.pos.z - c.center.z)).toBeLessThan(snap.storm!.r);
    expect(w.pos.y).toBeGreaterThan(snap.waterY + 1); // on land or a deck, not in the sea
    // Someone actually bridged onto the center island.
    expect(snap.pieces.filter((p) => p.kind === 'scaffold' && Math.hypot(p.pos.x - c.center.x, p.pos.z - c.center.z) < c.radius + 4).length).toBeGreaterThan(0);
  }, 300_000);
});

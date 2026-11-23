import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import type { Inventory, PieceKind, Vec3, WeaponKind } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';
import cases from './fixtures/stormEndgameReplay.json';

// Regression: the user's 8-PRO match (replay faefight-20261122-1927-02ce1c, build f4f212e, bit-exact re-sim). Three
// PRO bots died to the storm with the ring still ~100 s from closing:
// - Ash (#1), left on a dead rival's island (#2's) with $3.7k and 4 decks, can't walk home: its center bridge was
//   planned from home (unreachable) and decks only bought at the home shop, so it stood on the shore until the ring
//   passed (died 16:34). Now: it bridges from the island it stands on and buys at any shop it can walk to.
// - Cinder (#3) and Fern (#6), out on the bridges either side of island #4 (the one with a bridge to the center):
//   with no node under them the storm goal saw no walkable land and walked straight at the centre, pacing the deck
//   (died 16:03 / 16:13). Fern before that held the ring's edge on its own island until the ring passed it, a 150 m
//   walk round by #4 from the center. Now: from a bridge, the lane ends lead on; the trip round counts (stormLead).
// The fixture holds each case's pieces and players at that moment; the subject is a PRO bot, everyone else gone but
// one idle player on the center island (so the match runs on).
type P = { id: number; island: number; alive: boolean; eliminated: boolean; pos: Vec3; hp: number; shield: number; cash: number;
  pieces: Partial<Record<PieceKind, number>>; grapples: number; weapons: Partial<Inventory['weapons']> };
type Case = { time: number; storm: { r: number; rf: number }; players: P[]; pieces: { kind: PieceKind; owner: number; pos: Vec3; rotY: number }[] };

async function setup(c: Case, subject: number, drop: (q: Case['pieces'][number]) => boolean = () => false) {
  const keep = c.players.find((p) => p.id !== subject && p.alive && !p.eliminated)!.id;
  const m = await Match.create({
    players: c.players.map((p) => (p.id === subject ? { name: `s${p.id}`, isBot: true, difficulty: 'pro' as const } : { name: `p${p.id}`, isBot: false })),
    map: 'harbor', seed: 1,
  });
  m.tick(new Map());
  for (const q of c.pieces) if (!drop(q)) m.debugPlacePiece(q.kind, q.pos, q.rotY, q.owner);
  const me = c.players.find((p) => p.id === subject)!;
  m.debugTeleport(subject, me.pos);
  m.debugSetHp(subject, me.hp);
  m.debugGive(subject, { cash: Math.max(0, me.cash - 50), pieces: me.pieces, grapples: me.grapples, weapons: me.weapons as Record<WeaponKind, never> });
  const C = m.def.center;
  m.debugTeleport(keep, v3(C.center.x, C.groundY + 0.1, C.center.z));
  for (const p of c.players) if (p.id !== subject && p.id !== keep) m.debugEliminate(p.id);
  m.debugSetTime(c.time);
  return m;
}

/** Run until `until` (match time); the subject's fate and where it ended. */
function run(m: Match, subject: number, until: number) {
  let s = m.tick(new Map());
  let stormDeath = false;
  while (s.time < until) {
    s = m.tick(new Map());
    for (const e of s.events) if (e.type === 'kill' && e.data.victim === subject && e.data.cause === 'storm') stormDeath = true;
  }
  const p = s.players.find((q) => q.id === subject)!;
  return { stormDeath, alive: p.alive, d: Math.hypot(p.pos.x - s.storm!.x, p.pos.z - s.storm!.z), r: s.storm!.r };
}

describe('PRO bots in the storm endgame (replay 02ce1c)', () => {
  const at = (t: number) => (cases as Case[]).find((c) => c.time === t)!;
  test('Ash (#1), stranded on a dead rival\'s island with $3.7k: buys decks there, bridges to the center, survives', async () => {
    const m = await setup(at(905), 1);
    const r = run(m, 1, 1010);
    expect(r.stormDeath).toBe(false);
    expect(r.alive).toBe(true);
    expect(r.d).toBeLessThan(r.r);
  }, 300_000);

  test('Ash with the bridge home gone too (as it was for it in the match): buys decks at #2\'s shop, bridges from there', async () => {
    // The decks between islands 0 and 1 (the bridge Ash came over); at the moment of the match it had no walkable way home.
    const m0 = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }], map: 'harbor', seed: 1 });
    void m0; m0.dispose();
    const between = (q: Case['pieces'][number]) => q.kind === 'scaffold' && Math.hypot(q.pos.x, q.pos.z) > 85 && Math.atan2(q.pos.z, q.pos.x) < -2.5;
    const m = await setup(at(905), 1, between);
    const r = run(m, 1, 1010);
    expect(r.stormDeath).toBe(false);
    expect(r.alive).toBe(true);
    expect(r.d).toBeLessThan(r.r);
  }, 300_000);

  test('Cinder (#3), out on a bridge at 16 hp: walks on via island #4 and its center bridge, survives', async () => {
    const m = await setup(at(941), 3);
    const r = run(m, 3, 1000);
    expect(r.stormDeath).toBe(false);
    expect(r.d).toBeLessThan(r.r);
  }, 300_000);

  test('Fern (#6), on its island with the center a 150 m walk round: leaves in time, survives', async () => {
    const m = await setup(at(941), 6);
    const r = run(m, 6, 1000);
    expect(r.stormDeath).toBe(false);
    expect(r.d).toBeLessThan(r.r);
  }, 300_000);
});

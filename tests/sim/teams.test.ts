import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { islandAt } from '../../src/sim/bots/nav';
import { Match } from '../../src/sim/match';
import type { MatchSetup } from '../../src/sim/matchApi';
import { InvariantChecker } from '../../src/sim/invariants';
import { TEAM_COLORS, isAlly, islandOrder, modeSeats, resolveTeams, sidesLeft } from '../../src/sim/teams';
import type { Difficulty, Snapshot } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

const humans = (n: number, team?: (i: number) => number | undefined): MatchSetup['players'] =>
  Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, isBot: false, ...(team && team(i) !== undefined ? { team: team(i) } : {}) }));

describe('team helpers', () => {
  test('isAlly: same team, or the same player; free-for-all players are only their own ally', () => {
    expect(isAlly({ id: 1, team: 0 }, { id: 2, team: 0 })).toBe(true);
    expect(isAlly({ id: 1, team: 0 }, { id: 2, team: 1 })).toBe(false);
    expect(isAlly({ id: 1 }, { id: 2 })).toBe(false);
    expect(isAlly({ id: 1 }, { id: 1 })).toBe(true);
  });

  test('resolveTeams keeps picks while there is room and balances everyone else', () => {
    expect(resolveTeams([undefined, undefined, undefined], 0)).toEqual([undefined, undefined, undefined]);
    // 4v4: auto-balance alternates.
    expect(resolveTeams(Array(8).fill(undefined), 3)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    // Picks kept up to the team size (4), the 5th pick of team 0 overflows to team 1.
    expect(resolveTeams([0, 0, 0, 0, 0, undefined, undefined, undefined], 3)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    // 2v2v2v2: four teams of two.
    const duos = resolveTeams(Array(8).fill(undefined), 1);
    expect([0, 1, 2, 3].map((t) => duos.filter((x) => x === t).length)).toEqual([2, 2, 2, 2]);
    // Invalid picks are ignored.
    expect(resolveTeams([7, -1, 0.5, undefined, undefined, undefined], 2)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(modeSeats(0)).toBeNull();
    expect([1, 2, 3].map(modeSeats)).toEqual([8, 6, 8]);
  });

  test('islandOrder puts teammates on neighbouring islands', () => {
    expect(islandOrder([undefined, undefined, undefined])).toEqual([0, 1, 2]);
    expect(islandOrder([0, 1, 0, 1, 0, 1, 0, 1])).toEqual([0, 4, 1, 5, 2, 6, 3, 7]);
  });

  test('sidesLeft counts teams, and each teamless player as a side', () => {
    expect(sidesLeft([{ id: 1, team: 0, eliminated: false }, { id: 2, team: 0, eliminated: false }])).toBe(1);
    expect(sidesLeft([{ id: 1, eliminated: false }, { id: 2, eliminated: false }])).toBe(2);
    expect(sidesLeft([{ id: 1, team: 0, eliminated: true }, { id: 2, team: 1, eliminated: false }])).toBe(1);
  });
});

describe('teams match rules', () => {
  test('4v4: teams, neighbouring islands and team colours', async () => {
    const m = await Match.create({ players: humans(8), seed: 2, settings: { startCash: 200, suddenDeathSec: 900, genMult: 1, teamMode: 3 } });
    const snap = m.tick(new Map());
    const byTeam = [0, 1].map((t) => snap.players.filter((p) => p.team === t).map((p) => p.island).sort());
    expect(byTeam).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
    for (const p of snap.players) expect(m.def.colors![p.island]).toBe(TEAM_COLORS[p.team!]);
    m.dispose();
  });

  test('free-for-all leaves team unset and islands in seat order', async () => {
    const m = await Match.create({ players: humans(3), seed: 2 });
    const snap = m.tick(new Map());
    expect(snap.players.map((p) => [p.island, p.team])).toEqual([[0, undefined], [1, undefined], [2, undefined]]);
    m.dispose();
  });

  test('no friendly fire: a teammate\'s grenade spares you, an enemy\'s does not, your own still hurts', async () => {
    // 2v2: players 1, 3 on team 0; 2, 4 on team 1.
    const m = await Match.create({ players: humans(4, (i) => i % 2), seed: 3, settings: { startCash: 200, suddenDeathSec: 900, genMult: 1, teamMode: 2 } });
    let snap = m.tick(new Map());
    const p1 = snap.players.find((p) => p.id === 1)!;
    const at = v3(p1.pos.x + 8, p1.pos.y, p1.pos.z);
    m.debugTeleport(1, at);
    for (const id of [1]) m.debugSetHp(id, 100);
    for (let i = 0; i < 60; i++) snap = m.tick(new Map()); // spawn protection off
    m.debugExplode('grenade', v3(at.x, at.y + 0.3, at.z), 3); // teammate's
    snap = m.tick(new Map());
    expect(snap.players.find((p) => p.id === 1)!.hp).toBe(100);
    m.debugExplode('grenade', v3(at.x, at.y + 0.3, at.z), 1); // own
    snap = m.tick(new Map());
    const afterOwn = snap.players.find((p) => p.id === 1)!.hp;
    expect(afterOwn).toBeLessThan(100);
    m.debugExplode('grenade', v3(at.x, at.y + 0.3, at.z), 2); // enemy's
    snap = m.tick(new Map());
    expect(snap.players.find((p) => p.id === 1)!.hp).toBeLessThan(afterOwn);
    m.dispose();
  });

  test('a teammate\'s pieces never seal your bunker; an enemy\'s do', async () => {
    const m = await Match.create({ players: humans(4, (i) => i % 2), seed: 4, settings: { startCash: 200, suddenDeathSec: 900, genMult: 1, teamMode: 2 } });
    let snap = m.tick(new Map());
    const isl = snap.players.find((p) => p.id === 1)!.island;
    const ally = [0, 1, 2].map((d) => m.debugPlugDoor(isl, d, 3));
    snap = m.tick(new Map());
    expect(snap.sealed[isl]).toBe(false);
    expect(snap.players.find((p) => p.id === 1)!.doorsBlocked).toBe(0);
    for (const id of ally) m.debugRemovePiece(id);
    [0, 1, 2].forEach((d) => m.debugPlugDoor(isl, d, 2));
    snap = m.tick(new Map());
    expect(snap.sealed[isl]).toBe(true);
    m.dispose();
  });

  test('the match ends when one team is left, even with several of its players alive', async () => {
    const m = await Match.create({ players: humans(4, (i) => i % 2), seed: 5, settings: { startCash: 200, suddenDeathSec: 900, genMult: 1, teamMode: 2 } });
    let snap = m.tick(new Map());
    m.debugEliminate(2);
    snap = m.tick(new Map());
    expect(snap.winner).toBeNull();
    m.debugEliminate(4);
    snap = m.tick(new Map());
    expect(snap.winner === 1 || snap.winner === 3).toBe(true);
    expect(snap.events.some((e) => e.type === 'win')).toBe(true);
    m.dispose();
  });
});

const LIMIT = 25 * 60 * 30;

/** One full bot teams match: friendly hits, team pushes (2+ teammates on the same enemy island), assists. */
async function teamsBotMatch(mode: number, n: number, seed: number) {
  const diffs: Difficulty[] = ['medium', 'hard', 'pro'];
  const bots = new Map<number, Bot>();
  const m = await Match.create({
    players: Array.from({ length: n }, (_, i) => ({ name: '', isBot: true, difficulty: diffs[i % 3] })),
    seed, settings: { startCash: 200, suddenDeathSec: 600, genMult: 1, teamMode: mode },
  }, { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
  const checker = new InvariantChecker({ map: m.map });
  let snap: Snapshot = m.tick(new Map());
  const team = new Map(snap.players.map((p) => [p.id, p.team!]));
  let friendlyHits = 0, enemyHits = 0, pushTicks = 0, assistTicks = 0, defendTicks = 0, focusTicks = 0, kills = 0;
  for (let i = 0; i < LIMIT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    checker.observe(snap);
    for (const e of snap.events) {
      if (e.type === 'hit' && typeof e.data.by === 'number' && e.data.by !== e.data.target) {
        if (team.get(e.data.by) === team.get(e.data.target as number)) friendlyHits++; else enemyHits++;
      }
      if (e.type === 'kill' && typeof e.data.killer === 'number' && e.data.killer !== e.data.victim) kills++;
    }
    if (snap.tick % 15) continue;
    // Group push: two or more teammates on the same island that belongs to an enemy.
    const owner = new Map(snap.players.map((p) => [p.island, p]));
    const on = new Map<string, number>();
    for (const p of snap.players) {
      if (!p.alive) continue;
      const isl = islandAt(m.map, p.pos);
      const o = isl >= 0 ? owner.get(isl) : undefined;
      if (o && o.team !== p.team) on.set(`${p.team}:${isl}`, (on.get(`${p.team}:${isl}`) ?? 0) + 1);
    }
    if ([...on.values()].some((k) => k >= 2)) pushTicks++;
    for (const b of bots.values()) {
      if (b.currentGoal === 'assist') assistTicks++;
      if (b.teamDefender) defendTicks++;
    }
    // Focus: two teammates going after the same rival.
    const targets = new Map<string, number>();
    for (const b of bots.values()) if (b.currentTarget !== null) { const k = `${team.get(b.id)}:${b.currentTarget}`; targets.set(k, (targets.get(k) ?? 0) + 1); }
    if ([...targets.values()].some((k) => k >= 2)) focusTicks++;
  }
  checker.finish(snap);
  const left = snap.players.filter((p) => !p.eliminated);
  const res = { winner: snap.winner, winTeam: snap.winner !== null && snap.winner > 0 ? team.get(snap.winner) : null, time: snap.time, friendlyHits, enemyHits, kills, pushTicks, assistTicks, defendTicks, focusTicks, left, violations: checker.violations.filter((v) => v.kind === 'sealContradiction').map((v) => v.detail) };
  console.log(`teams mode ${mode} (${n} bots) seed ${seed}: winner #${res.winner} (team ${res.winTeam}) at ${(res.time / 60).toFixed(1)} min; kills ${kills}, enemy hits ${enemyHits}, friendly hits ${friendlyHits}; push ${pushTicks}, assist ${assistTicks}, defend ${defendTicks}, focus ${focusTicks} (half-second samples)`);
  m.dispose();
  return res;
}

describe('teams bot matches', () => {
  test('4v4 bots: the match finishes, no friendly damage, the team plays together', async () => {
    const r = await teamsBotMatch(3, 8, 21);
    expect(r.winner).not.toBeNull();
    expect(r.friendlyHits).toBe(0);
    expect(r.enemyHits).toBeGreaterThan(0);
    // Everyone left standing is on the winning team.
    if (r.winner! > 0) for (const p of r.left) expect(p.team).toBe(r.winTeam);
    expect(r.focusTicks).toBeGreaterThan(0);
    expect(r.pushTicks).toBeGreaterThan(0);
    expect(r.defendTicks).toBeGreaterThan(0);
    expect(r.violations).toEqual([]);
  }, 600_000);

  test('2v2v2v2 bots: the match finishes with no friendly damage', async () => {
    const r = await teamsBotMatch(1, 8, 22);
    expect(r.winner).not.toBeNull();
    expect(r.friendlyHits).toBe(0);
    expect(r.violations).toEqual([]);
  }, 600_000);
});

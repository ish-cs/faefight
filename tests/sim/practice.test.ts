import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { LIFECYCLE, PIECES, PLAYER } from '../../src/sim/constants';
import { eyePos } from '../../src/sim/combat';
import { doorwaysBlocked, PRACTICE, PRACTICE_START } from '../../src/sim/practice';
import { NO_INPUT, type MatchEvent, type PieceState, type PlayerInput, type PlayerState, type Snapshot } from '../../src/sim/types';
import { dist2D, sub, v3, yawOf } from '../../src/sim/vec';
import { buildMapDef } from '../../src/sim/map';

const idle = { makeBot: () => ({ think: () => NO_INPUT }) };
const practice = () => Match.create({ players: [{ name: 'You', isBot: false }], practice: true });
const normal = () => Match.create({ players: [{ name: 'You', isBot: false }, { name: 'Bot', isBot: true }] }, idle);
const me = (s: Snapshot) => s.players.find((p) => p.id === 1)!;
const byName = (s: Snapshot, name: string) => s.players.find((p) => p.name === name)!;
const run = (m: Match, n: number, input: Partial<PlayerInput> = {}) => {
  let s!: Snapshot; const events: MatchEvent[] = [];
  for (let i = 0; i < n; i++) { s = m.tick(new Map([[1, { ...NO_INPUT, ...input }]])); events.push(...s.events); }
  return { s, events };
};
/** Jump the sim clock (private) to just before sudden death. */
const setTime = (m: Match, t: number) => { (m as unknown as { s: { time: number } }).s.time = t; };
const aimAt = (from: PlayerState, at: { x: number; y: number; z: number }) => {
  const eye = eyePos(from), d = sub(at, eye);
  return { yaw: yawOf(d), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
};
/** Plug every doorway of island 0's bunker with a metal wall (the shape the seal rule wants). */
const sealIsland0 = (m: Match) => {
  for (const d of m.map[0].bunker.doorways) m.debugPlacePiece('metal', v3(d.center.x, m.map[0].groundY, d.center.z), d.yaw, 1);
};

describe('normal matches are unaffected by practice mode', () => {
  test('no dummies, buys cost cash and need the shop, sudden death and a result still happen', async () => {
    const m = await normal();
    let s = run(m, 1).s;
    expect(s.players).toHaveLength(2);
    expect(m.def.name).toBe('Harbor');
    const cash0 = me(s).inv.cash;
    // Far from the shop: nothing bought.
    s = run(m, 1, { shop: { buy: 'pistol' } }).s;
    expect(me(s).inv.weapons.pistol).toBeUndefined();
    expect(me(s).inv.cash).toBe(cash0);
    // At the shop: pistol bought, cash spent.
    const shop = m.map[me(s).island].shop;
    m.debugTeleport(1, v3(shop.x + 1, shop.y, shop.z));
    s = run(m, 1, { shop: { buy: 'pistol' } }).s;
    expect(me(s).inv.weapons.pistol).toBeDefined();
    expect(me(s).inv.cash).toBeLessThan(cash0);
    expect(() => m.practiceCommand({ kind: 'reset' })).toThrow(/not a practice match/);
    setTime(m, LIFECYCLE.suddenDeathAt - 0.01);
    s = run(m, 1).s;
    expect(s.suddenDeath).toBe(true);
    m.debugEliminate(2);
    expect(run(m, 1).s.winner).toBe(1);
  });

  test('a trapped player in a sealed bunker still gets the breakout countdown', async () => {
    const m = await normal();
    m.debugTeleport(1, m.map[0].spawn);
    sealIsland0(m);
    const s = run(m, 2).s;
    expect(s.sealed[0]).toBe(true);
    expect(me(s).breakoutUntil).not.toBeNull();
  });
});

describe('practice mode', () => {
  test('rejects anything but one human', async () => {
    await expect(Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: true }], practice: true })).rejects.toThrow(/exactly one human/);
  });

  test('range layout: you at the start with a kit, eight lane targets and three dummies, barges under far lanes', async () => {
    const m = await practice();
    const s = run(m, 1).s;
    expect(m.humanIds()).toEqual([1]);
    expect(m.def.name).toBe('Practice Range');
    const p = me(s);
    expect(dist2D(p.pos, PRACTICE_START)).toBeLessThan(0.2);
    expect(p.inv.weapons.rifle).toBeDefined();
    expect(p.hotbar.filter((k) => k === null)).toHaveLength(3);
    const names = s.players.filter((q) => q.isBot).map((q) => q.name);
    expect(names).toHaveLength(11);
    for (const d of PRACTICE.lanes) expect(names).toEqual(expect.arrayContaining([`Target ${d}m`, `Mover ${d}m`]));
    expect(names).toEqual(expect.arrayContaining(['Still dummy', 'Strafe dummy', 'Shooter dummy']));
    // Every target and dummy stands on something (none fell in the water after a second).
    const later = run(m, 30).s;
    for (const q of later.players) expect(q.alive && q.pos.y > 1.5).toBe(true);
    // The harbor map gained barges, nothing else changed about the islands.
    const harbor = buildMapDef(2, 'harbor', 1);
    expect(m.def.islands).toEqual(harbor.islands);
    expect(m.def.statics.length).toBeGreaterThan(harbor.statics.length);
  });

  test('infinite cash: buys anywhere are free and cash never drops; pieces never run out', async () => {
    const m = await practice();
    let s = run(m, 1).s;
    expect(me(s).inv.cash).toBe(PRACTICE.cash);
    // Nowhere near a shop: buy the rocket launcher.
    expect(dist2D(me(s).pos, m.map[0].shop)).toBeGreaterThan(5);
    s = run(m, 1, { shop: { buy: 'rocket' } }).s;
    expect(me(s).inv.weapons.rocket).toBeDefined();
    s = run(m, 1).s;
    expect(me(s).inv.cash).toBe(PRACTICE.cash);
    // Build a wall in front of us: placed, and the stack is still full.
    const before = s.pieces.length;
    const pos = v3(PRACTICE_START.x, PRACTICE_START.y, PRACTICE_START.z - 3);
    const r = run(m, 2, { build: { kind: 'wood', pos, rotY: 0, free: true } });
    expect(r.s.pieces.length).toBe(before + 1);
    expect(me(r.s).inv.pieces.wood).toBe(PRACTICE.pieces);
    expect(r.events.some((e) => e.type === 'placed')).toBe(true);
  });

  test('no timer: no sudden death past the normal limit, and never a result', async () => {
    const m = await practice();
    setTime(m, LIFECYCLE.suddenDeathAt + 5);
    const s = run(m, 3).s;
    expect(s.suddenDeath).toBe(false);
    expect(s.winner).toBeNull();
    expect(s.waterY).toBe(0);
  });

  test('no elimination: sealed in your own bunker you are never trapped or killed', async () => {
    const m = await practice();
    m.debugTeleport(1, m.map[0].spawn);
    sealIsland0(m);
    const { s, events } = run(m, Math.ceil((LIFECYCLE.breakoutSec + 1) * 30));
    expect(s.sealed[0]).toBe(true);
    expect(me(s).alive).toBe(true);
    expect(me(s).eliminated).toBe(false);
    expect(me(s).breakoutUntil).toBeNull();
    expect(events.some((e) => e.type === 'trapped' || e.type === 'eliminated')).toBe(false);
  });

  test('drowning or dying puts you straight back at the range start with your loadout', async () => {
    const m = await practice();
    run(m, 1, { shop: { buy: 'rocket' } });
    m.debugTeleport(1, v3(-40, -3, -60));
    const { s, events } = run(m, 1);
    expect(events.some((e) => e.type === 'kill' && e.data.victim === 1)).toBe(true);
    expect(me(s).alive).toBe(true);
    expect(dist2D(me(s).pos, PRACTICE_START)).toBeLessThan(0.2);
    expect(me(s).inv.weapons.rocket).toBeDefined();
    expect(me(s).inv.cash).toBe(PRACTICE.cash);
    expect(s.loot).toHaveLength(0);
    m.debugKill(1);
    expect(me(run(m, 1).s).alive).toBe(true);
  });

  test('shooting a lane target: hit events, headshots count, it goes down and stands back up', async () => {
    const m = await practice();
    m.practiceCommand({ kind: 'shooter', on: false });
    let s = run(m, 1).s;
    const target = byName(s, 'Target 10m');
    const head = v3(target.pos.x, target.pos.y + PLAYER.height - 0.15, target.pos.z);
    const hits: MatchEvent[] = [];
    let downAt = -1;
    for (let i = 0; i < 90 && downAt < 0; i++) {
      s = m.tick(new Map([[1, { ...NO_INPUT, ...aimAt(me(s), head), ads: true, fire: true }]]));
      hits.push(...s.events.filter((e) => e.type === 'hit' && e.data.by === 1 && e.data.target === target.id));
      if (s.events.some((e) => e.type === 'kill' && e.data.victim === target.id)) downAt = i;
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((e) => e.data.part === 'head')).toBe(true);
    expect(downAt).toBeGreaterThanOrEqual(0);
    s = run(m, Math.ceil(PRACTICE.reviveSec * 30) + 2).s;
    const back = s.players.find((p) => p.id === target.id)!;
    expect(back.alive).toBe(true);
    expect(back.hp).toBe(PLAYER.hp);
    expect(dist2D(back.pos, target.pos)).toBeLessThan(0.3);
    expect(back.eliminated).toBe(false);
  });

  test('movers strafe along their rail; the strafe dummy too', async () => {
    const m = await practice();
    const s0 = run(m, 1).s;
    const xs = (name: string) => byName(s0, name).pos.x;
    const start = { mover: xs('Mover 25m'), strafe: xs('Strafe dummy') };
    const seen = { mover: [] as number[], strafe: [] as number[] };
    for (let i = 0; i < 120; i++) {
      const s = run(m, 1).s;
      seen.mover.push(byName(s, 'Mover 25m').pos.x);
      seen.strafe.push(byName(s, 'Strafe dummy').pos.x);
    }
    const span = (a: number[]) => Math.max(...a) - Math.min(...a);
    expect(span(seen.mover)).toBeGreaterThan(1.5);
    expect(span(seen.mover)).toBeLessThan(2 * PRACTICE.railHalf + 1.5);
    expect(Math.max(...seen.mover.map((x) => Math.abs(x - start.mover)))).toBeLessThan(PRACTICE.railHalf + 0.8);
    expect(span(seen.strafe)).toBeGreaterThan(3);
  });

  test('the shooter dummy shoots back (weakly) and can be switched off', async () => {
    const m = await practice();
    // Stand in the open near the dummies so it has a clear line.
    const shooterId = byName(run(m, 1).s, 'Shooter dummy').id;
    m.debugTeleport(1, v3(-38, 2, 4));
    const on = run(m, 30 * 5).events.filter((e) => e.type === 'shot' && e.data.by === shooterId);
    expect(on.length).toBeGreaterThanOrEqual(1);
    expect(on.length).toBeLessThanOrEqual(4);
    m.practiceCommand({ kind: 'shooter', on: false });
    const off = run(m, 30 * 5).events.filter((e) => e.type === 'shot' && e.data.by === shooterId);
    expect(off).toHaveLength(0);
  });

  test('panel: dummies toggle, reset brings everyone home, clear removes pieces', async () => {
    const m = await practice();
    run(m, 1);
    m.practiceCommand({ kind: 'dummies', on: false });
    let s = run(m, 5).s;
    for (const n of ['Still dummy', 'Strafe dummy', 'Shooter dummy']) expect(byName(s, n).alive).toBe(false);
    expect(byName(s, 'Target 50m').alive).toBe(true);
    m.practiceCommand({ kind: 'dummies', on: true });
    s = run(m, 1).s;
    for (const n of ['Still dummy', 'Strafe dummy', 'Shooter dummy']) expect(byName(s, n).alive).toBe(true);

    m.debugPlacePiece('wood', v3(-40, 2, -12), 0, 1);
    m.debugPlacePiece('metal', v3(-36, 2, -12), 0, 1);
    m.debugTeleport(1, v3(-30, 2, 0));
    expect(run(m, 1).s.pieces).toHaveLength(2);
    m.practiceCommand({ kind: 'clearPieces' });
    s = run(m, 1).s;
    expect(s.pieces).toHaveLength(0);
    m.practiceCommand({ kind: 'reset' });
    s = run(m, 1).s;
    expect(dist2D(me(s).pos, PRACTICE_START)).toBeLessThan(0.2);
  });
});

describe('doorwaysBlocked (seal-check readout)', () => {
  const bunker = buildMapDef(2, 'harbor').islands[0].bunker;
  const g = bunker.center.y;
  const plug = (i: number, kind: PieceState['kind'] = 'metal'): PieceState => {
    const d = bunker.doorways[i];
    return { id: 100 + i, kind, owner: 1, pos: v3(d.center.x, g, d.center.z), rotY: d.yaw, hp: PIECES[kind].hp };
  };
  test('open bunker: nothing blocked', () => {
    expect(doorwaysBlocked(bunker, [])).toEqual([false, false, false]);
  });
  test('each plugged doorway shows as blocked, all three = sealed', () => {
    expect(doorwaysBlocked(bunker, [plug(0)])).toEqual([true, false, false]);
    expect(doorwaysBlocked(bunker, [plug(1), plug(2)])).toEqual([false, true, true]);
    expect(doorwaysBlocked(bunker, [plug(0), plug(1), plug(2, 'wood')])).toEqual([true, true, true]);
  });
  test('a ramp (walkable) does not block', () => {
    expect(doorwaysBlocked(bunker, [plug(0, 'ramp')])).toEqual([false, false, false]);
  });
});

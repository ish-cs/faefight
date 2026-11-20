import { beforeAll, describe, expect, test } from 'vitest';
import { killPlayer, newMatchState, tickLifecycle } from '../../src/sim/lifecycle';
import { Match } from '../../src/sim/match';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Physics } from '../../src/sim/physics';
import { newPlayer } from '../../src/sim/player';
import { LIFECYCLE } from '../../src/sim/constants';
import { NO_INPUT, type PlayerInput } from '../../src/sim/types';
import { add, forward, scale, v3 } from '../../src/sim/vec';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(3); });

async function core() {
  const physics = await Physics.create(map);
  const s = newMatchState(map);
  for (let i = 0; i < 3; i++) {
    const p = newPlayer(i + 1, `p${i + 1}`, false, i, map[i].spawn);
    s.players.set(p.id, p);
    physics.addPlayer(p.id, p.pos);
  }
  return { s, physics, p: (id: number) => s.players.get(id)! };
}

describe('kills / deaths', () => {
  test('new players start at 0 / 0', () => {
    const p = newPlayer(1, 'a', false, 0, map[0].spawn);
    expect(p.kills).toBe(0);
    expect(p.deaths).toBe(0);
  });

  test('a kill credits the killer and counts a death for the victim', async () => {
    const { s, physics, p } = await core();
    killPlayer(s, physics, 2, 1, false, 1);
    expect(p(1).kills).toBe(1);
    expect(p(1).deaths).toBe(0);
    expect(p(2).deaths).toBe(1);
    expect(p(2).kills).toBe(0);
  });

  test('killing an already dead player counts nothing', async () => {
    const { s, physics, p } = await core();
    killPlayer(s, physics, 2, 1, false, 1);
    killPlayer(s, physics, 2, 1.1, false, 1);
    expect(p(1).kills).toBe(1);
    expect(p(2).deaths).toBe(1);
  });

  test('killer null (fall, drown, collapse) and suicide: death only, no kill credit', async () => {
    const { s, physics, p } = await core();
    killPlayer(s, physics, 2, 1, false, null);
    killPlayer(s, physics, 3, 1, false, 3); // own grenade
    expect(p(2).deaths).toBe(1);
    expect(p(3).deaths).toBe(1);
    expect(p(3).kills).toBe(0);
    expect([...s.players.values()].reduce((n, x) => n + x.kills, 0)).toBe(0);
  });

  test('drowning in the tide counts a death with no killer', async () => {
    const { s, physics, p } = await core();
    s.waterY = p(2).pos.y + 1;
    const evs = tickLifecycle(s, physics, map, 1, 1 / 30);
    expect(evs.some((e) => e.type === 'kill' && e.data.victim === 2 && e.data.killer === null)).toBe(true);
    expect(p(2).deaths).toBe(1);
    expect(p(1).kills + p(2).kills + p(3).kills).toBe(0);
  });

  test('fall damage death in a match counts a death with no killer', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] });
    m.tick(new Map());
    m.debugDamagePlayer(2, 1000);
    const snap = m.tick(new Map());
    const b = snap.players.find((x) => x.id === 2)!;
    expect(b.alive).toBe(false);
    expect(b.deaths).toBe(1);
    expect(snap.players.find((x) => x.id === 1)!.kills).toBe(0);
    expect(m.debugKills()).toEqual([{ victim: 2, killer: null }]);
  });

  test('deaths keep counting across respawns', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] });
    m.tick(new Map());
    m.debugKill(2);
    for (let i = 0; i < Math.ceil((LIFECYCLE.respawnSec + 0.2) * 30); i++) m.tick(new Map());
    m.debugKill(2);
    const snap = m.tick(new Map());
    expect(snap.players.find((x) => x.id === 2)!.deaths).toBe(2);
  });
});

describe('eliminated players', () => {
  const all = (i: Partial<PlayerInput>) => ({ ...NO_INPUT, ...i });

  test('the sim ignores every input from an eliminated player', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }, { name: 'c', isBot: false }] });
    const yaw0 = m.map[0].bunker.facingYaw;
    m.debugTeleport(1, add(m.map[0].shop, scale(forward(yaw0), 1.5)));
    m.tick(new Map());
    m.debugEliminate(1);
    let snap = m.tick(new Map());
    const before = structuredClone(snap.players.find((x) => x.id === 1)!);
    expect(before.eliminated).toBe(true);
    expect(before.alive).toBe(false);
    expect(snap.winner).toBeNull(); // two left
    const piecesBefore = snap.pieces.length;
    for (let i = 0; i < 30; i++) {
      snap = m.tick(new Map([[1, all({
        moveZ: 1, moveX: 1, yaw: 1.2, pitch: 0.5, jump: true, sprint: true, fire: true, reload: true, interact: true,
        slot: 'pistol', throwGrenade: true, placeCharge: true, shop: { buy: 'pistol' }, vault: { deposit: { cash: 10 } },
        build: { kind: 'sandbags', pos: v3(before.pos.x + 2, before.pos.y, before.pos.z), rotY: 0, free: true },
      })]]));
    }
    const after = snap.players.find((x) => x.id === 1)!;
    expect(after.pos).toEqual(before.pos);
    expect(after.yaw).toBe(before.yaw);
    expect(after.inv).toEqual(before.inv);
    expect(after.vault).toEqual(before.vault);
    expect(after.alive).toBe(false);
    expect(snap.pieces.length).toBe(piecesBefore);
    expect(snap.events.filter((e) => e.type === 'shot' && e.data.by === 1)).toEqual([]);
  });

  test('eliminating down to one player ends the match', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] });
    m.tick(new Map());
    m.debugEliminate(2);
    const snap = m.tick(new Map());
    expect(snap.winner).toBe(1);
    expect(snap.players.find((x) => x.id === 2)!.deaths).toBe(1);
  });
});

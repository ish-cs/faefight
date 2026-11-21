import { beforeAll, describe, expect, test } from 'vitest';
import { killPlayer, newMatchState, tickLifecycle, type MatchStateCore } from '../../src/sim/lifecycle';
import { Physics } from '../../src/sim/physics';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { newPlayer } from '../../src/sim/player';
import { LIFECYCLE, MAP, PIECES } from '../../src/sim/constants';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';
import type { PieceState, Vec3 } from '../../src/sim/types';

let map: IslandLayout[];
beforeAll(() => { map = buildMap(2); });
const DT = 1 / 30;
const spot = (island: number, d: number, side = 3): Vec3 => {
  const i = map[island];
  const p = add(add(i.center, scale(forward(i.bunker.facingYaw), d)), scale(right(i.bunker.facingYaw), side));
  return v3(p.x, i.groundY, p.z);
};

async function setup() {
  const physics = await Physics.create(map);
  const s: MatchStateCore = newMatchState(map);
  const a = newPlayer(1, 'a', false, 0, map[0].spawn);
  const b = newPlayer(2, 'b', false, 1, map[1].spawn);
  for (const p of [a, b]) { s.players.set(p.id, p); physics.addPlayer(p.id, p.pos); }
  const run = (from: number, to: number) => {
    const evs = [];
    for (let t = from; t < to; t += DT) { s.time = t; evs.push(...tickLifecycle(s, physics, map, t, DT)); }
    return evs;
  };
  return { s, physics, a, b, run };
}

function sealIsland(s: MatchStateCore, island: number): PieceState[] {
  const out = map[island].bunker.doorways.map((d) => {
    const f = forward(d.yaw);
    const off = 0.15 + PIECES.steel.d / 2 + 0.05;
    const piece: PieceState = { id: s.nextId++, kind: 'steel', owner: 1, rotY: d.yaw, hp: 1200,
      pos: v3(d.center.x + f.x * off, d.center.y, d.center.z + f.z * off) };
    s.pieces.set(piece.id, piece);
    return piece;
  });
  return out;
}

describe('lifecycle', () => {
  test('kill on land drops a loot bag with everything carried', async () => {
    const { s, physics, b } = await setup();
    b.pos = spot(1, 5);
    b.inv.cash = 120;
    b.inv.weapons.smg = { mag: 30, spare: 90 };
    killPlayer(s, physics, 2, 0, false);
    expect(b.alive).toBe(false);
    expect(b.inv.cash).toBe(0);
    expect(b.inv.weapons).toEqual({});
    const bags = [...s.loot.values()];
    expect(bags).toHaveLength(1);
    expect(bags[0].inv.cash).toBe(120);
    expect(bags[0].inv.weapons.smg).toEqual({ mag: 30, spare: 90 });
  });

  test('death in water loses drop', async () => {
    const { s, physics, b } = await setup();
    b.inv.cash = 120;
    killPlayer(s, physics, 2, 0, true);
    expect(s.loot.size).toBe(0);
  });

  test('vault contents survive death', async () => {
    const { s, physics, b } = await setup();
    b.vault.cash = 400;
    killPlayer(s, physics, 2, 0, false);
    expect(b.vault.cash).toBe(400);
  });

  test('another player walking over the bag picks it up', async () => {
    const { s, physics, a, b, run } = await setup();
    b.pos = spot(1, 5);
    b.inv.cash = 120;
    killPlayer(s, physics, 2, 0, false);
    a.pos = add(spot(1, 5), v3(0.5, 0, 0));
    run(0, DT * 2);
    expect(a.inv.cash).toBe(50 + 120);
    expect(s.loot.size).toBe(0);
  });

  test('falling below the water kills', async () => {
    const { s, a, run } = await setup();
    a.pos = v3(0, -0.5, 0);
    const evs = run(0, DT * 2);
    expect(a.alive).toBe(false);
    expect(evs.some((e) => e.type === 'kill')).toBe(true);
  });

  test('respawns at spawn after LIFECYCLE.respawnSec with invulnerability', async () => {
    const { s, physics, b, run } = await setup();
    const R = LIFECYCLE.respawnSec;
    killPlayer(s, physics, 2, 0, false);
    run(0, R - 0.1);
    expect(b.alive).toBe(false);
    run(R - 0.1, R + 0.1);
    expect(b.alive).toBe(true);
    expect(b.hp).toBe(100);
    expect(b.pos).toEqual(map[1].spawn);
    expect(b.invulnUntil).toBeGreaterThan(R + 2.5);
  });

  test('sealed at respawn → respawns trapped; still inside after 10 s → eliminated', async () => {
    const { s, physics, b, run } = await setup();
    sealIsland(s, 1);
    const R = LIFECYCLE.respawnSec, B = LIFECYCLE.breakoutSec;
    killPlayer(s, physics, 2, 0, false);
    let evs = run(0, R + 0.2);
    expect(b.alive).toBe(true);
    expect(b.eliminated).toBe(false);
    expect(b.breakoutUntil).toBeCloseTo(R + B, 0);
    expect(evs.some((e) => e.type === 'trapped')).toBe(true);
    evs = run(R + 0.2, R + B - 0.1);
    expect(b.eliminated).toBe(false);
    evs = run(R + B - 0.1, R + B + 0.2);
    expect(b.eliminated).toBe(true);
    expect(b.alive).toBe(false);
    expect(s.winner).toBe(1);
    expect(evs.some((e) => e.type === 'eliminated')).toBe(true);
    expect(evs.some((e) => e.type === 'win')).toBe(true);
  });

  test('breaking out of the bunker within 10 s keeps you in the game', async () => {
    const { s, physics, b, run } = await setup();
    sealIsland(s, 1);
    const R = LIFECYCLE.respawnSec;
    killPlayer(s, physics, 2, 0, false);
    run(0, R + 0.2);
    b.pos = spot(1, 8); // walked out through a doorway they cleared
    run(R + 0.2, R + 11);
    expect(b.eliminated).toBe(false);
    expect(b.alive).toBe(true);
    expect(b.breakoutUntil).toBeNull();
  });

  test('dying while trapped is final', async () => {
    const { s, physics, b, run } = await setup();
    sealIsland(s, 1);
    const R = LIFECYCLE.respawnSec;
    killPlayer(s, physics, 2, 0, false);
    run(0, R + 2);
    killPlayer(s, physics, 2, R + 2, false);
    run(R + 2, R + 6);
    expect(b.eliminated).toBe(true);
  });

  test('unsealing before respawn restores respawn', async () => {
    const { s, physics, b, run } = await setup();
    const plates = sealIsland(s, 1);
    killPlayer(s, physics, 2, 0, false);
    run(0, 2);
    s.pieces.delete(plates[0].id);
    run(2, LIFECYCLE.respawnSec + 0.2);
    expect(b.alive).toBe(true);
    expect(b.eliminated).toBe(false);
  });

  test('sealed while alive outside → not eliminated until death', async () => {
    const { s, physics, b, run } = await setup();
    b.pos = spot(1, 8);
    sealIsland(s, 1);
    run(0, 5);
    expect(b.alive).toBe(true);
    expect(b.eliminated).toBe(false);
    const back = 5 + LIFECYCLE.respawnSec;
    killPlayer(s, physics, 2, 5, false);
    run(5, back + 0.2);
    expect(b.eliminated).toBe(false); // respawned trapped, 10 s to break out
    run(back + 0.2, back + 10.4);
    expect(b.eliminated).toBe(true);
  });

  test('sudden death at 900 s: storm starts, water stays put, bunkers count as sealed', async () => {
    const { s, physics, b, run } = await setup();
    const evs = run(LIFECYCLE.suddenDeathAt - 0.1, LIFECYCLE.suddenDeathAt + 10);
    expect(s.suddenDeath).toBe(true);
    expect(s.forcedSeal).toBe(true);
    expect(evs.some((e) => e.type === 'suddenDeath')).toBe(true);
    expect(s.waterY).toBe(MAP.waterY);
    expect(s.storm).not.toBeNull();
    killPlayer(s, physics, 2, s.time, false);
    run(s.time, s.time + LIFECYCLE.respawnSec + 0.2);
    expect(b.eliminated).toBe(true);
  });

  test('everyone eliminated at once is a draw (winner -1)', async () => {
    const { s, physics, run } = await setup();
    s.forcedSeal = true;
    killPlayer(s, physics, 1, 0, true);
    killPlayer(s, physics, 2, 0, true);
    run(0, LIFECYCLE.respawnSec + 0.2);
    expect(s.winner).toBe(-1);
  });
});

describe('respawn spot', () => {
  test('respawns beside a wall dropped on the spawn point, not inside it', async () => {
    const { s, physics, b, run } = await setup();
    const sp = map[1].spawn;
    const wall: PieceState = { id: s.nextId++, kind: 'wood', owner: 1, pos: v3(sp.x, sp.y, sp.z), rotY: map[1].bunker.facingYaw, hp: 250 };
    s.pieces.set(wall.id, wall);
    physics.addPiece(wall);
    killPlayer(s, physics, 2, 0, false);
    run(0, LIFECYCLE.respawnSec + 0.2);
    expect(b.alive).toBe(true);
    const hits = physics.overlapsBox(v3(b.pos.x, b.pos.y + 0.9, b.pos.z), v3(0.3, 0.85, 0.3), 0).filter((h) => h.type === 'piece');
    expect(hits).toEqual([]);
  });
});

describe('trapped inside a sealed bunker at any time', () => {
  test('alive inside your bunker when it gets sealed → 10 s to escape, then eliminated', async () => {
    const { s, b, run } = await setup();
    // b is standing at its spawn (inside the bunker) and the doors get plugged.
    sealIsland(s, 1);
    let evs = run(0, 0.2);
    expect(b.breakoutUntil).not.toBeNull();
    expect(evs.some((e) => e.type === 'trapped')).toBe(true);
    run(0.2, 9.8);
    expect(b.eliminated).toBe(false);
    evs = run(9.8, 10.4);
    expect(b.eliminated).toBe(true);
    expect(s.winner).toBe(1);
  });
  test('escaping before the countdown ends keeps you in', async () => {
    const { s, b, run } = await setup();
    sealIsland(s, 1);
    run(0, 3);
    b.pos = spot(1, 8);
    run(3, 12);
    expect(b.eliminated).toBe(false);
    expect(b.breakoutUntil).toBeNull();
  });
  test('walking back into your still-sealed bunker restarts the countdown', async () => {
    const { s, b, run } = await setup();
    b.pos = spot(1, 8);
    sealIsland(s, 1);
    run(0, 2);
    expect(b.breakoutUntil).toBeNull();
    b.pos = { ...map[1].spawn };
    run(2, 2.2);
    expect(b.breakoutUntil).not.toBeNull();
  });
});

describe('anti spawn-camping', () => {
  test('respawn with a pistol and one spare mag', async () => {
    const { s, physics, b, run } = await setup();
    killPlayer(s, physics, 2, 0, false);
    run(0, LIFECYCLE.respawnSec + 0.2);
    expect(b.inv.weapons.pistol).toEqual({ mag: 12, spare: 12 });
    expect(b.hotbar).toContain('pistol');
  });
  test('protected while inside the bunker, even long after the old 3 s window', async () => {
    const { s, physics, b, run } = await setup();
    const R = LIFECYCLE.respawnSec;
    killPlayer(s, physics, 2, 0, false);
    run(0, R + 7);
    expect(b.pos).toEqual(map[1].spawn); // still inside
    expect(b.invulnUntil).toBeGreaterThan(R + 7);
  });
  test('protection ends 3 s after leaving the bunker', async () => {
    const { s, physics, b, run } = await setup();
    const t = LIFECYCLE.respawnSec + 2;
    killPlayer(s, physics, 2, 0, false);
    run(0, t);
    b.pos = spot(1, 8);
    run(t, t + 0.2);
    expect(b.invulnUntil).toBeLessThanOrEqual(t + 0.2 + 3.05);
    expect(b.invulnUntil).toBeGreaterThan(t + 2.9);
  });
  test('protection is capped at 15 s even if you hide inside', async () => {
    const { s, physics, b, run } = await setup();
    killPlayer(s, physics, 2, 0, false);
    run(0, LIFECYCLE.respawnSec + 1);
    expect(b.invulnUntil).toBeLessThanOrEqual(LIFECYCLE.respawnSec + 15 + 0.1);
  });
});

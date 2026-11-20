import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type PlayerInput } from '../../src/sim/types';
import { add, dist2D, forward, right, scale, v3 } from '../../src/sim/vec';

const humans1v1 = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
const inputs = (id: number, i: Partial<PlayerInput>) => new Map([[id, { ...NO_INPUT, ...i }]]);

describe('Match', () => {
  test('1v1 starts with both players at their spawns', async () => {
    const m = await Match.create(humans1v1);
    const snap = m.tick(new Map());
    expect(snap.players).toHaveLength(2);
    snap.players.forEach((p, i) => expect(dist2D(p.pos, m.map[i].spawn)).toBeLessThan(0.05));
    expect(m.humanIds()).toEqual([1, 2]);
  });

  test('walking forward for one second covers about 5 m', async () => {
    const m = await Match.create(humans1v1);
    const yaw = m.map[0].bunker.facingYaw;
    let snap = m.tick(new Map());
    const start = snap.players[0].pos;
    for (let i = 0; i < 30; i++) snap = m.tick(inputs(1, { moveZ: 1, yaw }));
    expect(dist2D(snap.players[0].pos, start)).toBeGreaterThan(4.5);
    expect(dist2D(snap.players[0].pos, start)).toBeLessThan(5.5);
  });

  test('interact at the generator after 10 s collects about 50', async () => {
    const m = await Match.create(humans1v1);
    const g = m.map[0].generator;
    m.debugTeleport(1, add(g, scale(forward(m.map[0].bunker.facingYaw), 1.5)));
    for (let i = 0; i < 300; i++) m.tick(new Map());
    const snap = m.tick(inputs(1, { interact: true }));
    expect(snap.players[0].inv.cash).toBeGreaterThanOrEqual(50 + 49);
    expect(snap.players[0].inv.cash).toBeLessThanOrEqual(50 + 51);
  });

  test('buying at your own shop works, at an enemy shop it does not', async () => {
    const m = await Match.create(humans1v1);
    const yaw0 = m.map[0].bunker.facingYaw;
    m.debugTeleport(1, add(m.map[0].shop, scale(forward(yaw0), 1.5)));
    let snap = m.tick(inputs(1, { shop: { buy: 'pistol' } }));
    expect(snap.players[0].inv.weapons.pistol).toBeDefined();
    m.debugGive(1, { cash: 100 });
    m.debugTeleport(1, add(m.map[1].shop, scale(forward(m.map[1].bunker.facingYaw), 1.5)));
    snap = m.tick(inputs(1, { shop: { buy: 'sandbags' } }));
    expect(snap.players[0].inv.pieces.sandbags ?? 0).toBe(0);
  });

  test('build places a piece, consumes it, and makes you busy', async () => {
    const m = await Match.create(humans1v1);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw;
    const stand = add(add(isl.center, scale(forward(yaw), 4)), scale(right(yaw), 3));
    m.debugTeleport(1, v3(stand.x, isl.groundY, stand.z));
    m.debugGive(1, { pieces: { sandbags: 2 } });
    const target = add(stand, scale(forward(yaw), 3));
    const req = { kind: 'sandbags' as const, pos: v3(target.x, isl.groundY, target.z), rotY: yaw, free: false };
    expect(m.previewBuild(1, req).ok).toBe(true);
    let snap = m.tick(inputs(1, { build: req }));
    expect(snap.pieces).toHaveLength(1);
    expect(snap.players[0].inv.pieces.sandbags).toBe(1);
    expect(snap.events.some((e) => e.type === 'placed')).toBe(true);
    const req2 = { ...req, pos: add(req.pos, scale(right(yaw), 2.5)) };
    snap = m.tick(inputs(1, { build: req2 }));
    expect(snap.pieces).toHaveLength(1);
  });

  test('snapshots are not mutated by later ticks', async () => {
    const m = await Match.create(humans1v1);
    const first = m.tick(new Map());
    const x = first.players[0].pos.x;
    for (let i = 0; i < 30; i++) m.tick(inputs(1, { moveZ: 1, yaw: 1 }));
    expect(first.players[0].pos.x).toBe(x);
  });

  test('bot players get inputs from the bot factory', async () => {
    let calls = 0;
    const m = await Match.create(
      { players: [{ name: 'you', isBot: false }, { name: 'bot', isBot: true, difficulty: 'hard' }] },
      { makeBot: () => ({ think: (view) => { calls++; expect(view.self.id).toBe(2); return { ...NO_INPUT }; } }) },
    );
    m.tick(new Map());
    expect(calls).toBe(1);
    expect(m.humanIds()).toEqual([1]);
  });

  test('killing a sealed player ends a 1v1 with a winner', async () => {
    const m = await Match.create(humans1v1);
    const isl = m.map[1];
    m.debugGive(1, { pieces: { steel: 3 } });
    for (const d of isl.bunker.doorways) {
      const f = forward(d.yaw);
      const stand = add(d.center, scale(f, 3));
      m.debugTeleport(1, stand);
      m.tick(new Map());
      const off = 0.15 + 0.075 + 0.05;
      const snap = m.tick(inputs(1, { build: { kind: 'steel', pos: add(d.center, scale(f, off)), rotY: d.yaw, free: true } }));
      for (let i = 0; i < 61; i++) m.tick(new Map());
      expect(snap.events.some((e) => e.type === 'placed')).toBe(true);
    }
    const sealedSnap = m.tick(new Map());
    expect(sealedSnap.sealed[1]).toBe(true);
    m.debugKill(2);
    let snap = sealedSnap;
    for (let i = 0; i < 100; i++) snap = m.tick(new Map());
    expect(snap.winner).toBe(1);
  });
});

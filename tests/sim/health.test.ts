import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { add, forward, right, scale, v3 } from '../../src/sim/vec';

const humans = { players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] };
const run = (m: Match, secs: number) => { let s = m.tick(new Map()); for (let i = 1; i < secs * 30; i++) s = m.tick(new Map()); return s; };
const spot = (m: Match, d: number) => {
  const isl = m.map[0], yaw = isl.bunker.facingYaw;
  const p = add(add(isl.center, scale(forward(yaw), d)), scale(right(yaw), 3));
  return v3(p.x, isl.groundY, p.z);
};

describe('health regen', () => {
  test('nothing for the first 8 s after damage, then about 1 HP per second', async () => {
    const m = await Match.create(humans);
    m.debugDamagePlayer(1, 50);
    let s = run(m, 7.5);
    expect(s.players[0].hp).toBe(50);
    s = run(m, 10.5); // 18 s after the hit → ~10 s of regen
    expect(s.players[0].hp).toBeGreaterThanOrEqual(58);
    expect(s.players[0].hp).toBeLessThanOrEqual(62);
  });
  test('never above 100', async () => {
    const m = await Match.create(humans);
    m.debugDamagePlayer(1, 2);
    const s = run(m, 20);
    expect(s.players[0].hp).toBe(100);
  });
});

describe('fall damage', () => {
  test('a short drop (2 m) is free', async () => {
    const m = await Match.create(humans);
    const p = spot(m, 8);
    m.debugTeleport(1, v3(p.x, p.y + 2, p.z));
    expect(run(m, 2).players[0].hp).toBe(100);
  });
  test('a 6 m fall hurts about 20', async () => {
    const m = await Match.create(humans);
    const p = spot(m, 8);
    m.debugTeleport(1, v3(p.x, p.y + 6, p.z));
    const hp = run(m, 3).players[0].hp;
    expect(hp).toBeLessThan(90);
    expect(hp).toBeGreaterThan(65);
  });
  test('a 25 m fall kills', async () => {
    const m = await Match.create(humans);
    const p = spot(m, 8);
    m.debugTeleport(1, v3(p.x, p.y + 25, p.z));
    const s = run(m, 4);
    expect(s.events.length >= 0).toBe(true);
    expect(s.players[0].alive === false || s.players[0].hp === 100 /* respawned */).toBe(true);
    expect(m.debugKills().some((k) => k.victim === 1)).toBe(true);
  });
});

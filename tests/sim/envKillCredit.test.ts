import { describe, expect, test } from 'vitest';
import { LIFECYCLE, PLAYER, WEAPONS } from '../../src/sim/constants';
import { Match } from '../../src/sim/match';
import type { MatchEvent, PlayerInput, PlayerState, Vec3 } from '../../src/sim/types';
import { NO_INPUT } from '../../src/sim/types';
import { v3, yawOf } from '../../src/sim/vec';

/**
 * Environmental kill credit: a drowning, fall or storm death soon after a player hurt you, or after a player
 * broke what you stood on, is that player's kill ("X via water"). Repro of a real match (2026-11-22 replay
 * fe150d): ish rocketed the scaffold bridge a sealed bot stood on, the bot drowned, and nobody got the kill.
 */
const humans = { players: [{ name: 'ish', isBot: false }, { name: 'victim', isBot: false }], seed: 7 };
const internal = (m: Match, id: number): PlayerState => (m as unknown as { s: { players: Map<number, PlayerState> } }).s.players.get(id)!;
const now = (m: Match) => (m as unknown as { s: { time: number } }).s.time;

function place(m: Match, id: number, pos: Vec3) {
  m.debugTeleport(id, pos);
  const p = internal(m, id);
  p.invulnUntil = 0;
  p.spawnProtected = false;
}

function aim(from: Vec3, at: Vec3): { yaw: number; pitch: number } {
  const ey = from.y + PLAYER.eyeHeight;
  const dx = at.x - from.x, dy = at.y - ey, dz = at.z - from.z;
  return { yaw: yawOf({ x: dx, z: dz }), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

function run(m: Match, sec: number, input: (t: number) => Map<number, PlayerInput> = () => new Map(), until?: (ev: MatchEvent[]) => boolean) {
  const events: MatchEvent[] = [];
  for (let i = 0; i < sec * 30; i++) {
    events.push(...m.tick(input(i)).events);
    if (until?.(events)) break;
  }
  return events;
}

/**
 * Island 0 (centre -40, 0; radius 22, ground y 2) ends at z ≈ 22. A scaffold bridge runs out along +z:
 * A rests on the island (19.5..23.5), B and C hang off it over the water. The victim stands on C.
 */
async function bridge() {
  const m = await Match.create(humans);
  const y = m.map[0].groundY;
  const A = m.debugPlacePiece('scaffold', v3(-40, y, 21.5), 0, 2);
  const B = m.debugPlacePiece('scaffold', v3(-40, y, 25.5), 0, 2);
  const C = m.debugPlacePiece('scaffold', v3(-40, y, 29.5), 0, 2);
  const shooter = v3(-40, y + 0.05, 8);
  place(m, 1, shooter);
  place(m, 2, v3(-40, y + 0.25, 29.5));
  m.debugGive(1, { weapons: { rocket: { mag: WEAPONS.rocket.mag, spare: 2 } } });
  run(m, 0.5);
  const ids = new Set(m.tick(new Map()).pieces.map((p) => p.id));
  expect([A, B, C].every((id) => ids.has(id)), 'the bridge stands before the shot').toBe(true);
  expect(internal(m, 2).pos.y).toBeGreaterThan(y);
  return { m, A, B, C, shooter, y };
}

/** Player 1 fires one rocket at piece A's deck. */
function rocketAt(m: Match, from: Vec3, at: Vec3) {
  const a = aim(from, at);
  return (t: number) => new Map([[1, { ...NO_INPUT, ...a, slot: 'rocket', fire: t >= 3 && t < 6 } as PlayerInput]]);
}

describe('environmental kill credit', () => {
  test('rocket breaks the scaffold under a player, they drown: the shooter gets the kill "via water"', async () => {
    const { m, A, C, shooter, y } = await bridge();
    const events = run(m, 6, rocketAt(m, shooter, v3(-40, y + 0.1, 21.5)), (ev) => ev.some((e) => e.type === 'kill'));
    expect(events.some((e) => e.type === 'destroyed' && e.data.piece === A && !e.data.collapse), 'the rocket broke A').toBe(true);
    expect(events.some((e) => e.type === 'destroyed' && e.data.piece === C && e.data.collapse), 'C fell with it').toBe(true);
    expect(events.some((e) => e.type === 'hit' && e.data.target === 2), 'the blast never touched the victim').toBe(false);
    const kill = events.find((e) => e.type === 'kill')!;
    expect(kill.data).toMatchObject({ victim: 2, killer: 1, inWater: true, via: 'water' });
    expect(internal(m, 1).kills).toBe(1);
  }, 30_000);

  test('the same drowning while trapped by a seal is an elimination, credited to the shooter', async () => {
    const { m, shooter, y } = await bridge();
    internal(m, 2).breakoutUntil = now(m) + LIFECYCLE.breakoutSec;
    const events = run(m, 6, rocketAt(m, shooter, v3(-40, y + 0.1, 21.5)), (ev) => ev.some((e) => e.type === 'kill'));
    expect(events.find((e) => e.type === 'kill')!.data).toMatchObject({ victim: 2, killer: 1, via: 'water' });
    expect(events.some((e) => e.type === 'eliminated' && e.data.player === 2)).toBe(true);
    expect(internal(m, 1).kills).toBe(1);
  }, 30_000);

  test(`drowning more than ${LIFECYCLE.envCreditSec} s after the last hit is nobody's kill`, async () => {
    const { m } = await bridge();
    const v = internal(m, 2);
    v.hurtBy = { by: 1, at: now(m) - LIFECYCLE.envCreditSec - 0.1 };
    m.debugTeleport(2, v3(-40, -1, 40));
    const kill = run(m, 1, undefined, (ev) => ev.some((e) => e.type === 'kill')).find((e) => e.type === 'kill')!;
    expect(kill.data.killer).toBeNull();
    expect(kill.data.via).toBeUndefined();
    expect(internal(m, 1).kills).toBe(0);
  }, 30_000);

  test('a hit from a player, then a drowning within the window: their kill', async () => {
    const { m } = await bridge();
    internal(m, 2).hurtBy = { by: 1, at: now(m) - 1 };
    m.debugTeleport(2, v3(-40, -1, 40));
    const kill = run(m, 1, undefined, (ev) => ev.some((e) => e.type === 'kill')).find((e) => e.type === 'kill')!;
    expect(kill.data).toMatchObject({ victim: 2, killer: 1, via: 'water' });
  }, 30_000);

  test('a fatal fall soon after a player hurt you is their kill "via fall"', async () => {
    const { m, y } = await bridge();
    const v = internal(m, 2);
    m.debugSetHp(2, 5);
    v.hurtBy = { by: 1, at: now(m) };
    m.debugTeleport(2, v3(-40, y + 12, 12));
    const kill = run(m, 3, undefined, (ev) => ev.some((e) => e.type === 'kill')).find((e) => e.type === 'kill')!;
    expect(kill.data).toMatchObject({ victim: 2, killer: 1, inWater: false, via: 'fall' });
    expect(internal(m, 1).kills).toBe(1);
  }, 30_000);

  test('the credit is gone after death (a later drowning in the next life is not theirs)', async () => {
    const { m } = await bridge();
    internal(m, 2).hurtBy = { by: 1, at: now(m) };
    m.debugKill(2, null);
    expect(internal(m, 2).hurtBy).toBeUndefined();
  }, 30_000);
});

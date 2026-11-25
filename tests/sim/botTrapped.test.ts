import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { LIFECYCLE, MAP, PIECES } from '../../src/sim/constants';
import { forward, v3 } from '../../src/sim/vec';
import type { PieceKind, Snapshot } from '../../src/sim/types';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * Respawned into a sealed bunker with the respawn kit (pistol, $0): the bot must keep working on a plug for the
 * whole 10 s countdown, never stand still (user replay 7d6d6fa: 4 of 7 bot eliminations stood on "Clear the plug"
 * firing nothing).
 */
async function trapped(kinds: PieceKind[], seed = 1, outer?: { door: number; kind: PieceKind; out: number }) {
  const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'medium' }, { name: 'b', isBot: true, difficulty: 'medium' }], seed });
  for (let i = 0; i < 30; i++) m.tick(new Map());
  const isl = m.map[1];
  m.debugKill(2);
  const ids = isl.bunker.doorways.map((d, k) => {
    const kind = kinds[k % kinds.length];
    const out = forward(d.yaw), off = MAP.bunker.wall / 2 + PIECES[kind].d / 2 + 0.05;
    return m.debugPlacePiece(kind, v3(d.center.x + out.x * off, d.center.y - 0.01, d.center.z + out.z * off), d.yaw, 1);
  });
  if (outer) {
    const d = isl.bunker.doorways[outer.door], o = forward(d.yaw);
    m.debugPlacePiece(outer.kind, v3(d.center.x + o.x * outer.out, d.center.y - 0.01, d.center.z + o.z * outer.out), d.yaw, 1);
  }
  let snap: Snapshot = m.tick(new Map());
  for (let i = 0; i < 30 * (LIFECYCLE.respawnSec + 1) && !snap.players.find((p) => p.id === 2)!.alive; i++) snap = m.tick(new Map());
  const me = () => snap.players.find((p) => p.id === 2)!;
  expect(me().breakoutUntil).not.toBeNull();
  let shots = 0, escaped = false, idleTicks = 0;
  const from = snap.time;
  while (snap.time < from + LIFECYCLE.breakoutSec + 0.5 && !me().eliminated) {
    snap = m.tick(new Map());
    for (const e of snap.events) {
      if (e.type === 'shot' && e.data.by === 2) shots++;
      if (e.type === 'escaped' && e.data.player === 2) escaped = true;
    }
    if (ENV.TRAP_TRACE && snap.tick % 15 === 0) {
      const b = m.botBrain(2) as unknown as { currentGoal: string } | null;
      console.log(snap.time.toFixed(1), b?.currentGoal, me().pos.x.toFixed(2), me().pos.y.toFixed(2), me().pos.z.toFixed(2), me().equipped,
        JSON.stringify(me().inv.weapons), ids.map((id) => snap.pieces.find((p) => p.id === id)?.hp ?? 0).join('/'));
    }
    if (me().alive && Math.hypot(me().vel.x, me().vel.z) < 0.05) idleTicks++;
  }
  m.dispose();
  return { shots, escaped, eliminated: me().eliminated, hp: ids.map((id) => snap.pieces.find((p) => p.id === id)?.hp ?? 0), idleTicks };
}

describe('respawned trapped in a sealed bunker', () => {
  test('one wood plug among metal: shoots the wood out and escapes', async () => {
    const r = await trapped(['metal', 'wood', 'metal']);
    expect(r.escaped).toBe(true);
  });
  test('all metal plus a second wood layer outside one doorway (replay 7d6d6fa p8): still fires', async () => {
    const r = await trapped(['metal'], 1, { door: 0, kind: 'wood', out: 2 });
    expect(r.shots).toBeGreaterThan(5);
  });
  test('all metal, pistol only: still has a go at a plug (fires), never just stands there', async () => {
    const r = await trapped(['metal']);
    expect(r.shots).toBeGreaterThan(5);
  });
});

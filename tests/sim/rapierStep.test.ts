import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { stepWorld } from '../../src/sim/rapierStep';

/** A small world with statics and tumbling dynamic boxes, stepped `n` times by `step`; returns every body's state. */
function simulate(step: (w: RAPIER.World) => void, n: number): number[] {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  w.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0));
  for (let i = 0; i < 12; i++) w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 1, 0.5).setTranslation(i * 1.7 - 9, 1, (i % 3) - 1));
  const bodies = Array.from({ length: 10 }, (_, i) => {
    const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation((i % 5) - 2, 2 + i * 0.9, Math.floor(i / 5) - 0.5)
      .setRotation({ x: 0.1 * i, y: 0.2, z: 0, w: 1 }).setAngvel({ x: i, y: 0, z: -i }).setCcdEnabled(true));
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.4, 0.3, 0.5).setFriction(0.7).setRestitution(0.1), b);
    return b;
  });
  for (let i = 0; i < n; i++) step(w);
  const out = bodies.flatMap((b) => {
    const t = b.translation(), r = b.rotation(), v = b.linvel(), a = b.angvel();
    return [t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, a.x, a.y, a.z, b.isSleeping() ? 1 : 0];
  });
  w.free();
  return out;
}

describe('stepWorld (world.step without soft-body bookkeeping)', () => {
  test('steps bit-identically to world.step (fails loudly if a Rapier bump changes the pipeline API)', async () => {
    await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }] }); // initialises RAPIER
    const a = simulate((w) => w.step(), 400), b = simulate(stepWorld, 400);
    expect(b).toEqual(a);
    expect(a.some((x, i) => i % 14 === 1 && x < 1)).toBe(true); // the boxes really fell and collided
  });
});

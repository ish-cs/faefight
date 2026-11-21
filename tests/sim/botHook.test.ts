import { describe, expect, test } from 'vitest';
import { GRAPPLE } from '../../src/sim/constants';
import { crossTo, escapeFrom, hookReady, yankReason } from '../../src/sim/bots/hook';
import { HOOK } from '../../src/sim/bots/params';
import type { BotView } from '../../src/sim/bots/view';
import { newPlayer } from '../../src/sim/player';
import type { Vec3 } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

/** Two flat islands (radius 20, top at y 2) along x, their near edges `gap` m apart; water below. */
function world(gap: number) {
  const a = { index: 0, center: v3(0, 0, 0), radius: 20, groundY: 2, bunker: null };
  const b = { index: 1, center: v3(40 + gap, 0, 0), radius: 20, groundY: 2, bunker: null };
  const nodes = [a, b];
  const groundAt = (x: number, z: number) => (nodes.some((n) => Math.hypot(x - n.center.x, z - n.center.z) <= n.radius) ? 2 : null);
  // The hook ray: first point where it drops onto an island top (y = 2), or nothing.
  const castHook = (o: Vec3, dir: Vec3) => {
    for (let t = 0.5; t <= GRAPPLE.range; t += 0.25) {
      const p = v3(o.x + dir.x * t, o.y + dir.y * t, o.z + dir.z * t);
      if (p.y <= 2 && groundAt(p.x, p.z) !== null) return { point: v3(p.x, 2, p.z), dist: t, player: null };
    }
    return null;
  };
  return { nodes, groundAt, castHook };
}

function viewAt(gap: number, pos: Vec3): BotView {
  const w = world(gap);
  const self = newPlayer(1, 'b', true, 0, pos);
  self.inv.grapples = 3;
  self.hotbar[0] = 'grapple';
  const eye = v3(pos.x, pos.y + 1.6, pos.z);
  return {
    now: 10, self, enemies: [], others: [], map: [], pieces: [], generators: [], sealed: [], hurt: [], shots: [], feed: [], loot: [],
    waterY: 0, suddenDeath: false, groundAt: w.groundAt, canPlace: () => ({ ok: false, reason: 'test' }) as never,
    castHook: (dir) => w.castHook(eye, dir),
  } as BotView;
}

describe('bot grappling hook decisions (bots/hook.ts)', () => {
  test('hook ready: needs uses, a slot, and nothing out or cooling down', () => {
    const v = viewAt(20, v3(19, 2, 0));
    expect(hookReady(v.self, 10)).toBe(true);
    v.self.hookReadyAt = 11;
    expect(hookReady(v.self, 10)).toBe(false);
    v.self.hookReadyAt = 0;
    v.self.inv.grapples = 0;
    expect(hookReady(v.self, 10)).toBe(false);
  });

  test('crosses a gap it can reach, lands on the far island; too far: nothing', () => {
    const v = viewAt(20, v3(19, 2, 0));
    const it = crossTo(v, HOOK, world(20).nodes[1]);
    expect(it?.why).toBe('cross');
    if (it?.why !== 'cross') return;
    expect(it.to.x).toBeGreaterThan(40); // the far island's near edge
    expect(it.to.x).toBeLessThan(50);
    expect(crossTo(viewAt(45, v3(19, 2, 0)), HOOK, world(45).nodes[1])).toBeNull();
  });

  test('escapes to solid ground away from the enemy', () => {
    const v = viewAt(20, v3(-6, 2, 0));
    const it = escapeFrom(v, HOOK, v3(-11, 2, 0), (p) => (Math.hypot(p.x, p.z) <= 20 ? 0 : -1));
    expect(it?.why).toBe('escape');
    if (it?.why === 'escape') expect(it.to.x).toBeGreaterThan(HOOK.escapeMin - 1);
  });

  test('yanks across water, off high ground, or into shotgun range; not when it does not pay', () => {
    const v = viewAt(20, v3(19, 2, 0));
    const e = newPlayer(2, 'e', true, 1, v3(19 + 22, 2, 0));
    expect(yankReason(v, HOOK, e, 22, 'rifle')).toMatch(/water/);
    const near = newPlayer(2, 'e', true, 0, v3(9, 2, 0));
    expect(yankReason(v, HOOK, near, 10, 'rifle')).toBeNull();
    expect(yankReason(v, HOOK, near, 10, 'shotgun')).toMatch(/shotgun range/);
    const up = newPlayer(2, 'e', true, 0, v3(9, 6, 0));
    expect(yankReason(v, HOOK, up, 10, 'rifle')).toMatch(/high ground/);
    up.spawnProtected = true;
    expect(yankReason(v, HOOK, up, 10, 'rifle')).toBeNull();
  });
});

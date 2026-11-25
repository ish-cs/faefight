import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { Bot } from '../../src/sim/bots/bot';
import { withParams, type BotParams } from '../../src/sim/bots/params';
import { BARRIER, barrierBoxes, bunkerBarrierBoxes } from '../../src/sim/barriers';
import { LIFECYCLE, MAP, PIECES, PLAYER } from '../../src/sim/constants';
import { validatePlacement } from '../../src/sim/building';
import { insideBunker, withinIsland } from '../../src/sim/bots/nav';
import { loadMatch, saveMatch } from '../../src/net/matchCheckpoint';
import { stateHash } from '../../src/sim/replay/hash';
import type { Physics } from '../../src/sim/physics';
import type { MatchEvent, PlayerInput, Snapshot } from '../../src/sim/types';
import { NO_INPUT } from '../../src/sim/types';
import { add, dist2D, forward, scale, v3 } from '../../src/sim/vec';

const SD = LIFECYCLE.suddenDeathAt;
const humans = (n = 2, seed = 3) => Match.create({ players: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, isBot: false })), seed });
const phys = (m: Match) => (m as unknown as { physics: Physics }).physics;
const run = (m: Match, sec: number, inputs: Map<number, PlayerInput> = new Map()) => {
  const evs: MatchEvent[] = [];
  let snap!: Snapshot;
  for (let i = 0; i < Math.round(sec * 30); i++) { snap = m.tick(inputs); evs.push(...snap.events); }
  return { snap, evs };
};
/** Run up to just past sudden death (the forced seal). */
const toSuddenDeath = (m: Match) => { m.debugSetTime(SD - 0.5); return run(m, 1); };
const eye = (p: { x: number; y: number; z: number }) => v3(p.x, p.y + 1.4, p.z);

describe('sudden-death barriers', () => {
  test('geometry: one slab per doorway, filling the opening from just inside the room to just proud of the wall', () => {
    const def = { bunker: { center: v3(0, 0, 0), facingYaw: 0.7, doorways: [] as { center: ReturnType<typeof v3>; yaw: number; width: number }[] } };
    const off = MAP.bunker.interior / 2 + MAP.bunker.wall / 2;
    for (const d of [0, Math.PI / 2, -Math.PI / 2]) def.bunker.doorways.push({ center: scale(forward(0.7 + d), off), yaw: 0.7 + d, width: MAP.bunker.doorWidth });
    const boxes = bunkerBarrierBoxes(def.bunker);
    expect(boxes).toHaveLength(3);
    boxes.forEach((b, i) => {
      const d = def.bunker.doorways[i];
      expect(b.rotY).toBe(d.yaw);
      expect(b.half.x * 2).toBeGreaterThan(MAP.bunker.doorWidth); // overlaps both jambs
      expect(b.half.y * 2).toBeGreaterThan(MAP.bunker.doorHeight); // covers the opening
      expect(b.half.y * 2).toBeLessThan(MAP.bunker.height);
      // Inner face just inside the room's wall face, outer face proud of the wall.
      const along = (b.center.x - d.center.x) * forward(d.yaw).x + (b.center.z - d.center.z) * forward(d.yaw).z;
      expect(along - b.half.z).toBeCloseTo(-(MAP.bunker.wall / 2 - BARRIER.inset), 6);
      expect(along + b.half.z).toBeCloseTo(MAP.bunker.wall / 2 + BARRIER.proud, 6);
      expect(b.center.y - b.half.y).toBeCloseTo(d.center.y, 6);
    });
  });

  test('the forced seal drops a barrier on every doorway of every bunker; one allSealed event, no per-bunker sealed events', async () => {
    const m = await humans(4);
    const before = run(m, 0.2).snap;
    expect(before.barrierAt).toBeUndefined();
    expect(phys(m).barrierCount).toBe(0);
    const { snap, evs } = toSuddenDeath(m);
    expect(snap.suddenDeath).toBe(true);
    expect(snap.sealed).toEqual([true, true, true, true]);
    expect(snap.barrierAt).toBeGreaterThanOrEqual(SD);
    const doorways = m.map.reduce((n, isl) => n + isl.bunker.doorways.length, 0);
    expect(doorways).toBe(12);
    expect(phys(m).barrierCount).toBe(doorways);
    expect(evs.filter((e) => e.type === 'allSealed')).toEqual([{ t: snap.barrierAt, type: 'allSealed', data: { barriers: doorways } }]);
    expect(evs.filter((e) => e.type === 'sealed')).toEqual([]);
    // ...and never again.
    const later = run(m, 5).evs;
    expect(later.filter((e) => e.type === 'allSealed' || e.type === 'sealed' || e.type === 'unsealed')).toEqual([]);
    expect(phys(m).barrierCount).toBe(doorways);
    // Every doorway is now a wall for sight and bullets: a ray from outside into the room stops at the slab.
    for (const box of barrierBoxes(m.map)) {
      const out = forward(box.rotY);
      const from = add(box.center, scale(out, 3));
      const hit = phys(m).raycast(v3(from.x, box.center.y, from.z), scale(out, -1), 6, undefined, true);
      expect(hit?.hit.type).toBe('world');
      expect(hit!.dist).toBeCloseTo(3 - box.half.z, 2);
    }
  });

  test('normal (pre-sudden-death) seals still announce per bunker', async () => {
    const m = await humans(2);
    for (const d of [0, 1, 2]) m.debugPlugDoor(0, d, 2);
    const { evs } = run(m, 0.5);
    expect(evs.filter((e) => e.type === 'sealed').map((e) => e.data.island)).toEqual([0]);
    expect(evs.some((e) => e.type === 'allSealed')).toBe(false);
  });

  test('indestructible: rockets, charges, grenades and gunfire leave every barrier standing', async () => {
    const m = await humans(2);
    toSuddenDeath(m);
    const boxes = barrierBoxes(m.map);
    for (const b of boxes) {
      const front = add(b.center, scale(forward(b.rotY), b.half.z + 0.2));
      for (const kind of ['rocket', 'charge', 'grenade'] as const) m.debugExplode(kind, v3(front.x, b.center.y - 0.6, front.z), 1);
    }
    const { evs } = run(m, 2);
    expect(evs.filter((e) => e.type === 'explosion').length).toBeGreaterThan(0);
    // A rifleman emptying a mag into the first barrier from 4 m.
    const b = boxes[0];
    const spot = add(b.center, scale(forward(b.rotY), 4));
    m.debugTeleport(1, v3(spot.x, m.map[0].groundY, spot.z));
    m.debugGive(1, { weapons: { rifle: { mag: 30, spare: 90 } } } as never);
    const yaw = b.rotY; // forward(rotY) points out of the bunker: face back toward it
    const fire = new Map([[1, { ...NO_INPUT, yaw: yaw + Math.PI, pitch: 0, fire: true, slot: 'rifle' } as PlayerInput]]);
    run(m, 3, fire);
    expect(phys(m).barrierCount).toBe(boxes.length);
    for (const x of boxes) {
      const out = forward(x.rotY);
      const from = add(x.center, scale(out, 2));
      expect(phys(m).raycast(v3(from.x, x.center.y, from.z), scale(out, -1), 4, undefined, true)?.hit.type).toBe('world');
    }
  });

  test('a wall: nobody walks through a doorway, and nothing can be built over a barrier', async () => {
    const m = await humans(2);
    toSuddenDeath(m);
    const isl = m.map[1];
    const d = isl.bunker.doorways[0];
    const start = add(d.center, scale(forward(d.yaw), 2.5));
    m.debugTeleport(2, v3(start.x, isl.groundY, start.z));
    // Walk straight in through the front doorway for 3 s.
    const walkIn = new Map([[2, { ...NO_INPUT, yaw: d.yaw + Math.PI, pitch: 0, moveZ: 1 } as PlayerInput]]);
    const { snap } = run(m, 3, walkIn);
    const me = snap.players.find((p) => p.id === 2)!;
    expect(insideBunker(isl.bunker, me.pos)).toBe(false);
    // Pressed right up against the slab's face (it walked in), but never past it.
    const face = MAP.bunker.interior / 2 + MAP.bunker.wall + BARRIER.proud;
    expect(dist2D(me.pos, isl.bunker.center)).toBeGreaterThan(face + PLAYER.radius - 0.05);
    expect(dist2D(me.pos, isl.bunker.center)).toBeLessThan(face + PLAYER.radius + 0.2);
    // A wall piece right where the slab is: refused, or nudged off it (any piece may kiss a wall by the placement
    // slack, OVERLAP_SLACK = 0.12 m of its thickness, as against the bunker walls; never more).
    for (const b of barrierBoxes(m.map)) {
      const pl = validatePlacement(phys(m), 'wood', v3(b.center.x, b.center.y - b.half.y, b.center.z), b.rotY, start);
      if (!pl.ok) continue;
      const along = (pl.pos.x - b.center.x) * forward(b.rotY).x + (pl.pos.z - b.center.z) * forward(b.rotY).z;
      expect(Math.abs(along)).toBeGreaterThanOrEqual(b.half.z + PIECES.wood.d / 2 - 0.12 - 1e-6);
    }
  });

  test('the drop crushes plugs under the slabs and shoves anyone in a doorway to their own side', async () => {
    const m = await humans(2);
    const plug = m.debugPlugDoor(0, 1, 2);
    run(m, 0.2);
    const isl = m.map[1];
    const [front] = isl.bunker.doorways;
    // Player 2 straddles the front doorway on the room side; player 1 stands in its own left doorway, outer side.
    const inSide = add(front.center, scale(forward(front.yaw), -0.1));
    m.debugTeleport(2, v3(inSide.x, isl.groundY, inSide.z));
    const p1d = m.map[0].bunker.doorways[2];
    const outSide = add(p1d.center, scale(forward(p1d.yaw), 0.2));
    m.debugTeleport(1, v3(outSide.x, m.map[0].groundY, outSide.z));
    const { snap, evs } = toSuddenDeath(m);
    const crushed = evs.filter((e) => e.type === 'destroyed' && e.data.crushed);
    expect(crushed.map((e) => e.data.piece)).toEqual([plug]);
    expect(snap.pieces.some((p) => p.id === plug)).toBe(false);
    const p2 = snap.players.find((p) => p.id === 2)!, p1 = snap.players.find((p) => p.id === 1)!;
    expect(insideBunker(isl.bunker, p2.pos)).toBe(true);
    expect(insideBunker(m.map[0].bunker, p1.pos)).toBe(false);
    // Neither overlaps a slab.
    for (const p of [p1, p2]) {
      const hits = phys(m).overlapsBox(v3(p.pos.x, p.pos.y + PLAYER.height / 2, p.pos.z), v3(PLAYER.radius - 0.03, PLAYER.height / 2 - 0.1, PLAYER.radius - 0.03), 0);
      expect(hits.filter((h) => h.type === 'world')).toEqual([]);
    }
  });

  test('checkpoint (host migration) and fork keep the barriers; a restore from before sudden death drops them identically', async () => {
    const pre = await humans(3, 11);
    pre.debugSetTime(SD - 2);
    run(pre, 0.5);
    const restoredPre = await loadMatch(saveMatch(pre));
    for (let i = 0; i < 90; i++) {
      const a = pre.tick(new Map()), b = restoredPre.tick(new Map());
      expect(stateHash(b), `tick ${a.tick}`).toBe(stateHash(a));
    }
    expect(phys(restoredPre).barrierCount).toBe(9);

    const r = await loadMatch(saveMatch(pre));
    expect(phys(r).barrierCount).toBe(9);
    const f = pre.fork();
    expect(phys(f).barrierCount).toBe(9);
    for (let i = 0; i < 60; i++) {
      const a = pre.tick(new Map()), b = r.tick(new Map()), c = f.tick(new Map());
      expect(stateHash(b)).toBe(stateHash(a));
      expect(stateHash(c)).toBe(stateHash(a));
      expect(b.barrierAt).toBe(a.barrierAt);
    }
    const box = barrierBoxes(r.map)[4];
    const out = forward(box.rotY), from = add(box.center, scale(out, 2));
    expect(phys(r).raycast(v3(from.x, box.center.y, from.z), scale(out, -1), 4, undefined, true)?.hit.type).toBe('world');
    for (const x of [pre, restoredPre, r, f]) x.dispose();
  }, 60_000);
});

describe('bots and the barriers', () => {
  const off = MAP.bunker.interior / 2 + MAP.bunker.wall / 2;
  const bunker = { center: v3(0, 0, 0), facingYaw: 0, doorways: [0, Math.PI / 2, -Math.PI / 2].map((d) => ({ center: scale(forward(d), off), yaw: d, width: MAP.bunker.doorWidth })) };
  const isl = { bunker };
  const face = MAP.bunker.interior / 2 + MAP.bunker.wall + BARRIER.proud;

  test('nav: with the barriers up there is no way in or out, and routes round the bunker clear the slabs', () => {
    const inside = v3(0.5, 0, 0.5), outside = v3(0, 0, -8);
    // Before sudden death: out through a doorway.
    expect(dist2D(withinIsland(isl, inside, outside), inside)).toBeGreaterThan(0.5);
    // Inside, barriers up: stay put (never walk into a slab).
    expect(withinIsland(isl, inside, outside, () => true, true)).toEqual(inside);
    // Outside wanting in: wait in front of the nearest slab, clear of it.
    const wait = withinIsland(isl, outside, inside, () => true, true);
    expect(dist2D(wait, bunker.center)).toBeGreaterThan(face + PLAYER.radius + 0.3);
    // Round the bunker: the waypoint keeps a body's width off the slabs' faces.
    const wp = withinIsland(isl, v3(-5, 0, -2.9), v3(5, 0, -2.9), () => true, true);
    expect(Math.max(Math.abs(wp.x), Math.abs(wp.z))).toBeGreaterThan(face + PLAYER.radius);
  });

  test('a bot caught inside its own bunker at sudden death holds still instead of pushing into a slab', async () => {
    const m = await Match.create({ players: [{ name: 'a', isBot: true, difficulty: 'hard' }, { name: 'b', isBot: true, difficulty: 'hard' }], seed: 5 });
    const home = m.map[run(m, 1).snap.players.find((p) => p.id === 1)!.island];
    m.debugSetTime(SD - 0.2);
    m.debugTeleport(1, v3(home.bunker.center.x, home.groundY, home.bunker.center.z));
    // Pushing into a slab shows as standing at its face while trying to move: the character controller jitters along
    // it (and the stuck recovery kicks in, side-stepping back and forth). Holding still = barely any path walked.
    let path = 0, last: Snapshot['players'][number]['pos'] | null = null, ticks = 0;
    for (let i = 0; i < 8 * 30; i++) {
      const s = m.tick(new Map());
      const me = s.players.find((p) => p.id === 1)!;
      if (!me.alive || s.time < SD + 1) continue;
      expect(insideBunker(home.bunker, me.pos)).toBe(true);
      if (last) path += dist2D(last, me.pos);
      last = { ...me.pos };
      ticks++;
    }
    expect(ticks).toBeGreaterThan(30);
    expect(path).toBeLessThan(3);
    m.dispose();
  }, 60_000);
});

describe('bots and the sudden-death barriers', () => {
  const DIFFS = ['pro', 'hard', 'medium', 'easy'] as const;
  const zero = (k: string) => Object.fromEntries(DIFFS.map((d) => [`drive.${k}.${d}`, 0]));
  /** Unaware of the slabs: both barrier knobs at 0 for every skill. */
  const BLIND = withParams({ ...zero('barrierLead'), ...zero('shutInRange') });

  /**
   * 4 bots, each in its own bunker (the spawn) `lead` s before sudden death, spectated from the first decision: what
   * each decided while still inside, and whether it was out of every bunker when the slabs dropped.
   */
  const fromBunker = async (seed: number, lead: number, params?: BotParams) => {
    const bots = new Map<number, Bot>();
    const m = await Match.create({ players: DIFFS.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
      { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng, undefined, params); b.watch(true); bots.set(id, b); return b; } });
    m.debugSetTime(SD - lead);
    let snap = m.tick(new Map());
    const first = new Map([...bots].map(([id, b]) => [b.difficulty, b.debugBrain()] as const));
    while (!snap.events.some((e) => e.type === 'allSealed')) snap = m.tick(new Map());
    const map = (m as unknown as { map: { bunker: Parameters<typeof insideBunker>[0] }[] }).map;
    const out = new Map(snap.players.map((p) => [bots.get(p.id)!.difficulty, !map.some((isl) => insideBunker(isl.bunker, p.pos))] as const));
    m.dispose();
    return { first, out };
  };

  test('medium+ bots leave their bunker for good reason before the slabs drop (drive.barrierLead, debugBrain shows it)', async () => {
    for (const seed of [1, 2, 3]) {
      const aware = await fromBunker(seed, 10);
      const blind = await fromBunker(seed, 10, BLIND);
      for (const d of ['pro', 'hard', 'medium'] as const) {
        const dg = aware.first.get(d)!;
        expect(dg.goal, `${d} seed ${seed}`).toBe('storm');
        const storm = dg.scores.find(([g]) => g === 'storm')!;
        expect(storm[3].map(([label]) => label)).toContain('barriers drop soon');
        expect(dg.why).toMatch(/slabs/);
        expect(aware.out.get(d), `${d} seed ${seed} out at the drop`).toBe(true);
        // Without the knob the same bot in the same spot has no barrier reason (it leaves on chores, if at all).
        expect(blind.first.get(d)!.goal).not.toBe('storm');
      }
      // Easy (barrierLead 0) doesn't know about the slabs.
      expect(aware.first.get('easy')!.goal).not.toBe('storm');
    }
  }, 120_000);

  test('in sudden death, an enemy shut in a bunker further than drive.shutInRange is left to the storm (not picked, not hunted)', async () => {
    const m = await humans(2, 2);
    const map = (m as unknown as { map: Parameters<typeof barrierBoxes>[0] }).map;
    const inside = { pos: v3(map[1].bunker.center.x, map[1].groundY, map[1].bunker.center.z) }, outside = { pos: add(inside.pos, v3(0, 0, 9)) };
    type Rules = {
      shutInIgnored(view: object, e: object, d: number): boolean;
      rivalShutIn(c: object): boolean;
      mem: { seen: Map<number, { pos: ReturnType<typeof v3>; t: number }> };
    };
    const rules = (d: 'pro' | 'medium' | 'easy', params?: BotParams) => new Bot(1, d, () => 0.5, undefined, params) as unknown as Rules;
    const sd = { suddenDeath: true, map, now: SD + 5, suddenDeathAt: SD };
    const pre = { ...sd, suddenDeath: false, now: SD - 5 };
    const pro = rules('pro'), med = rules('medium'), easy = rules('easy'), blind = rules('pro', BLIND);
    expect(pro.shutInIgnored(sd, inside, 20)).toBe(true);
    expect(pro.shutInIgnored(sd, inside, 5)).toBe(false); // close: they can shoot out the slits, answer them
    expect(pro.shutInIgnored(sd, outside, 20)).toBe(false); // out in the open: a real target
    expect(pro.shutInIgnored(pre, inside, 20)).toBe(false); // no slabs yet: they can still come out
    expect(med.shutInIgnored(sd, inside, 12)).toBe(false); // medium's range is longer (14 m)
    expect(med.shutInIgnored(sd, inside, 20)).toBe(true);
    expect(easy.shutInIgnored(sd, inside, 100)).toBe(false); // easy doesn't know
    expect(blind.shutInIgnored(sd, inside, 100)).toBe(false);
    // The rival hunt: seen inside a bunker after the drop = nothing to walk to; seen inside before it = may have left.
    const c = (b: Rules, t: number, at = inside.pos) => { b.mem.seen.set(2, { pos: at, t }); return { view: sd, rival: { id: 2 } }; };
    expect(pro.rivalShutIn(c(pro, SD + 1))).toBe(true);
    expect(pro.rivalShutIn(c(pro, SD - 1))).toBe(false);
    expect(pro.rivalShutIn(c(pro, SD + 1, outside.pos))).toBe(false);
    expect(blind.rivalShutIn(c(blind, SD + 1))).toBe(false);
    m.dispose();
  });
});

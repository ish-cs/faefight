import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { buildMapDef, type IslandLayout, type MapTemplate } from '../../src/sim/map';
import { inBunkerArea, PROP_KINDS, propBlockedBy, propZones } from '../../src/sim/props';
import { boxesOverlap } from '../../src/sim/propZones';
import { ISLAND_DECOR } from '../../src/client/world/decor';
import { NO_INPUT, type PlayerInput, type Snapshot, type Vec3 } from '../../src/sim/types';
import { add, dist, dist2D, forward, right, scale, v3 } from '../../src/sim/vec';

const humans = (n: number) => ({ players: Array.from({ length: n }, (_, i) => ({ name: 'p' + i, isBot: false })) });
const bots = (n: number, difficulty: 'easy' | 'hard' = 'hard') => ({ players: Array.from({ length: n }, (_, i) => ({ name: 'Bot', isBot: true, difficulty })) });
const inputs = (id: number, i: Partial<PlayerInput>) => new Map([[id, { ...NO_INPUT, ...i }]]);
/** Island-local (fwd toward the middle, side) → world, at height y. */
const at = (isl: IslandLayout, fwd: number, side: number, y = isl.groundY): Vec3 => {
  const p = add(add(isl.center, scale(forward(isl.bunker.facingYaw), fwd)), scale(right(isl.bunker.facingYaw), side));
  return v3(p.x, y, p.z);
};
const run = (m: Match, n: number, inp: Map<number, PlayerInput> = new Map()) => { let s!: Snapshot; for (let i = 0; i < n; i++) s = m.tick(inp); return s; };

describe('prop placement', () => {
  for (const template of ['harbor', 'yard'] as MapTemplate[]) for (const n of [2, 4, 8]) {
    test(`${template} ${n}p: deterministic per seed, on the ground, clear of bunkers, zones, cover, cosmetics and paths`, () => {
      const a = buildMapDef(n, template, 7), b = buildMapDef(n, template, 7);
      expect(a.props).toEqual(b.props);
      const props = a.props!;
      expect(props.length).toBeGreaterThanOrEqual(n * 3);
      if (n === 8) expect(props.length).toBeLessThanOrEqual(42);
      const zones = propZones(a);
      for (const p of props) {
        const k = PROP_KINDS[p.kind];
        // nothing floating: the lowest prop of a stack rests on the island top, a stacked one on the one below
        const below = props.find((q) => q !== p && dist2D(q.pos, p.pos) < 0.05 && q.pos.y < p.pos.y);
        const floor = below ? below.pos.y + PROP_KINDS[below.kind].ext.y : a.islands[0].groundY;
        expect(p.pos.y - k.ext.y - floor).toBeGreaterThanOrEqual(0);
        expect(p.pos.y - k.ext.y - floor).toBeLessThan(0.03);
        if (below) continue;
        const yaw = 2 * Math.atan2(p.rot[1], p.rot[3]);
        expect(propBlockedBy(a, p.kind, p.pos, yaw, zones)).toBeNull();
        expect(inBunkerArea(a.islands, p.pos, Math.hypot(k.ext.x, k.ext.z))).toBe(false);
        for (const z of zones) expect(boxesOverlap(p.pos, k.ext, 0, z)).toBe(false);
      }
    });
  }

  test('harbor props stay off the gravel paths', () => {
    const def = buildMapDef(8, 'harbor', 3);
    for (const p of def.props!) {
      if (p.island < 0) continue;
      const isl = def.islands[p.island];
      const r = Math.hypot(PROP_KINDS[p.kind].ext.x, PROP_KINDS[p.kind].ext.z);
      for (const path of ISLAND_DECOR.gravelPaths) {
        for (let i = 0; i + 1 < path.pts.length; i++) {
          // decor x = lateral, z = back toward the bunker (= -fwd)
          const A = at(isl, -path.pts[i][1], path.pts[i][0]), B = at(isl, -path.pts[i + 1][1], path.pts[i + 1][0]);
          const dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz;
          const t = Math.max(0, Math.min(1, ((p.pos.x - A.x) * dx + (p.pos.z - A.z) * dz) / l2));
          const d = Math.hypot(A.x + dx * t - p.pos.x, A.z + dz * t - p.pos.z);
          expect(d, `${p.kind} ${p.id} on a path`).toBeGreaterThan(r + path.w / 2);
        }
      }
    }
  });
});

describe('gameplay props (sim)', () => {
  test('settle at match start: nothing is displaced while idle', async () => {
    const m = await Match.create(humans(8));
    expect(m.debugProps()!.count).toBeGreaterThan(30);
    const s = run(m, 90);
    expect(s.props ?? []).toEqual([]);
  });

  test('a player stands on a crate, then jumps off and lands on the ground', async () => {
    const m = await Match.create(humans(2));
    const ps = m.debugProps()!;
    const isl = m.map[0];
    const crate = m.def.props!.find((p) => p.kind === 'crate' && p.island === 0 && p.pos.y < isl.groundY + 0.6)!;
    const top = ps.restPose(crate.id)!.pos.y + PROP_KINDS.crate.ext.y;
    m.debugTeleport(1, v3(crate.pos.x, top + 0.05, crate.pos.z));
    let s = run(m, 20);
    const me = () => s.players[0];
    expect(Math.abs(me().pos.y - top)).toBeLessThan(0.1);
    expect(me().mv?.grounded).toBe(true);
    const yaw = isl.bunker.facingYaw;
    s = m.tick(inputs(1, { jump: true, moveZ: 1, yaw }));
    for (let i = 0; i < 45; i++) s = m.tick(inputs(1, { moveZ: 1, yaw }));
    expect(Math.abs(me().pos.y - isl.groundY)).toBeLessThan(0.05);
    expect(dist2D(me().pos, crate.pos)).toBeGreaterThan(2);
    expect(me().alive).toBe(true);
  });

  test('walking into a drum pushes it along, slower than walking', async () => {
    const m = await Match.create(humans(2));
    const ps = m.debugProps()!, isl = m.map[0];
    const drum = m.def.props!.find((p) => p.kind === 'drum' && p.island === 0)!;
    const spot = at(isl, -6, 0, isl.groundY + PROP_KINDS.drum.ext.y + 0.02);
    ps.debugPlace(drum.id, spot);
    run(m, 20);
    const start = ps.pose(drum.id)!.pos;
    m.debugTeleport(1, at(isl, -8.5, 0));
    const yaw = isl.bunker.facingYaw;
    const s = run(m, 60, inputs(1, { moveZ: 1, yaw }));
    const end = ps.pose(drum.id)!.pos;
    const fwd = forward(yaw);
    const moved = (end.x - start.x) * fwd.x + (end.z - start.z) * fwd.z;
    expect(moved).toBeGreaterThan(1.5);
    const walked = dist2D(s.players[0].pos, at(isl, -8.5, 0));
    expect(moved).toBeLessThan(walked);
    expect(s.props?.some((p) => p.id === drum.id)).toBe(true);
  });

  test('a heavy IBC moves slower than a crate when pushed the same way', async () => {
    const pushed = async (kind: 'ibc' | 'crate') => {
      const m = await Match.create(humans(2));
      const ps = m.debugProps()!, isl = m.map[0];
      const p = m.def.props!.find((x) => x.kind === kind && x.island === 0 && x.pos.y < isl.groundY + 0.7)!;
      ps.debugPlace(p.id, at(isl, -6, 0, isl.groundY + PROP_KINDS[kind].ext.y + 0.02));
      run(m, 20);
      const a = ps.pose(p.id)!.pos;
      m.debugTeleport(1, at(isl, -8.5, 0));
      run(m, 60, inputs(1, { moveZ: 1, yaw: isl.bunker.facingYaw }));
      return dist2D(ps.pose(p.id)!.pos, a);
    };
    const crate = await pushed('crate'), ibc = await pushed('ibc');
    expect(ibc).toBeGreaterThan(0.3);
    expect(ibc).toBeLessThan(crate * 0.7);
  });

  test('a grenade blast flings nearby props', async () => {
    const m = await Match.create(humans(2));
    const ps = m.debugProps()!, isl = m.map[0];
    const drum = m.def.props!.find((p) => p.kind === 'drum' && p.island === 0)!;
    ps.debugPlace(drum.id, at(isl, -6, 0, isl.groundY + PROP_KINDS.drum.ext.y + 0.02));
    run(m, 20);
    const start = ps.pose(drum.id)!;
    m.debugTeleport(1, at(isl, -8, 0));
    m.debugSetHp(1, 100000);
    m.debugGive(1, { grenades: 1 });
    m.tick(inputs(1, { throwGrenade: true, yaw: isl.bunker.facingYaw, pitch: -1.3 }));
    let peak = 0;
    for (let i = 0; i < 120; i++) { m.tick(new Map()); peak = Math.max(peak, ps.pose(drum.id)!.pos.y - start.pos.y); }
    const end = ps.pose(drum.id)!;
    expect(dist(end.pos, start.pos) > 0.5 || peak > 0.3).toBe(true);
  });

  test('props never seal a bunker, and get out of doorways and interiors', async () => {
    const m = await Match.create(humans(2));
    const ps = m.debugProps()!, isl = m.map[0];
    const ours = m.def.props!.filter((p) => p.island === 0).slice(0, 4);
    const spots = [...isl.bunker.doorways.map((d) => d.center), isl.bunker.center];
    ours.forEach((p, i) => ps.debugPlace(p.id, v3(spots[i].x, isl.groundY + PROP_KINDS[p.kind].ext.y + 0.02, spots[i].z)));
    m.debugTeleport(1, at(isl, 0, 8)); // out of the bunker, away from the props' spawns
    let s = m.tick(new Map());
    expect(s.sealed[0]).toBe(false);
    for (let i = 0; i < 90; i++) { s = m.tick(new Map()); expect(s.sealed[0]).toBe(false); }
    for (const p of ours) expect(inBunkerArea(m.map, ps.pose(p.id)!.pos)).toBe(false);
  });

  test('a prop in a doorway is slid out even while someone stands on its spawn', async () => {
    const m = await Match.create(humans(2));
    const ps = m.debugProps()!, isl = m.map[0];
    const p = m.def.props!.find((x) => x.island === 0 && x.kind === 'drum')!;
    m.debugTeleport(1, v3(p.pos.x + 0.6, isl.groundY, p.pos.z));
    const d = isl.bunker.doorways[0].center;
    ps.debugPlace(p.id, v3(d.x, isl.groundY + PROP_KINDS.drum.ext.y + 0.02, d.z));
    run(m, 90);
    expect(inBunkerArea(m.map, ps.pose(p.id)!.pos)).toBe(false);
  });

  test('props in the water float or sink, then respawn', async () => {
    const m = await Match.create(humans(2));
    const ps = m.debugProps()!, isl = m.map[0];
    const crate = m.def.props!.find((x) => x.island === 0 && x.kind === 'drum')!;
    const off = add(isl.center, scale(forward(isl.bunker.facingYaw), -isl.radius - 4));
    ps.debugPlace(crate.id, v3(off.x, 1.5, off.z));
    run(m, 150);
    const y = ps.pose(crate.id)!.pos.y;
    expect(Math.abs(y - m.def.waterY)).toBeLessThan(0.5); // floating at the surface
    m.debugTeleport(1, at(m.map[1], 0, 0));
    m.debugTeleport(2, at(m.map[1], 2, 0));
    run(m, 30 * 16);
    expect(dist(ps.pose(crate.id)!.pos, ps.restPose(crate.id)!.pos)).toBeLessThan(0.05);
  });

  test('replays are deterministic with props moving', async () => {
    const play = async () => {
      const m = await Match.create({ ...bots(8, 'hard'), seed: 42 });
      const ps = m.debugProps()!;
      // knock a few props around: drop them from height so they tumble
      for (const id of [1, 5, 9, 14]) { const r = ps.restPose(id)!.pos; ps.debugPlace(id, v3(r.x + 0.3, r.y + 3, r.z)); }
      const trace: string[] = [];
      for (let i = 0; i < 600; i++) {
        const s = m.tick(new Map());
        if (i % 30 === 0) trace.push(JSON.stringify([s.props, s.players.map((p) => [p.pos, p.hp])]));
      }
      return trace;
    };
    const a = await play(), b = await play();
    expect(a.some((t) => t.includes('"p":'))).toBe(true);
    expect(b).toEqual(a);
  });

  test('bots do not stall on props: a bot pushes through a crowd of props to its generator', async () => {
    const m = await Match.create({ ...bots(2, 'hard'), seed: 5 });
    const ps = m.debugProps()!, isl = m.map[0];
    const ours = m.def.props!.filter((p) => p.island === 0);
    // pile them on the walk from the bunker's front door to the generator
    const line = [at(isl, -10.5, -0.6), at(isl, -8.5, -1.8), at(isl, -6.5, -3), at(isl, -4.5, -4)];
    ours.slice(0, line.length).forEach((p, i) => ps.debugPlace(p.id, v3(line[i].x, isl.groundY + PROP_KINDS[p.kind].ext.y + 0.02, line[i].z)));
    let prev = 0, collected = false;
    const track: Vec3[] = [];
    for (let i = 0; i < 30 * 45 && !collected; i++) {
      const s = m.tick(new Map());
      const g = s.generators.find((x) => x.island === 0)!.stored;
      if (prev - g > 20) collected = true;
      prev = g;
      if (i % 30 === 0) track.push(s.players[0].pos);
    }
    expect(collected).toBe(true);
    // and it kept moving (no 8 s stretch within half a metre while it had somewhere to go)
    for (let i = 8; i < track.length; i++) expect(dist2D(track[i], track[i - 8])).toBeGreaterThan(0.5);
  });
});

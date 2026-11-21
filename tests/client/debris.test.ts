import { describe, expect, test } from 'vitest';
import { MAP } from '../../src/sim/constants';
import { buildMapDef, type MapDef } from '../../src/sim/map';
import { blockedOnCenter, blockedOnIsland, DEBRIS_SPEC, placeDebris, quayFrame, toLocal } from '../../src/client/world/debrisPlace';
import { DebrisSim } from '../../src/client/world/debrisSim';
import { ISLAND_DECOR } from '../../src/client/world/decor';

const defs: MapDef[] = [buildMapDef(8, 'harbor', 1), buildMapDef(4, 'yard', 7), buildMapDef(2, 'harbor', 3)];

/** Which surface a spawn stands on, or null if it floats in the air / over water. */
function groundAt(def: MapDef, x: number, z: number): number | null {
  for (const isl of def.islands) {
    if (Math.hypot(x - isl.center.x, z - isl.center.z) <= isl.radius) return isl.groundY;
    const l = toLocal(isl, x, z), f = quayFrame(isl, def.islands.length);
    if (Math.abs(l.x) <= f.hw && l.z >= f.z0 && l.z <= f.z0 + 80) return f.top;
  }
  const c = def.center;
  if (Math.hypot(x - c.center.x, z - c.center.z) <= c.radius) return c.groundY;
  return null;
}

describe('debris placement', () => {
  test('deterministic per seed, different across seeds', () => {
    const a = placeDebris(defs[0]), b = placeDebris(buildMapDef(8, 'harbor', 1));
    expect(a).toEqual(b);
    expect(placeDebris(buildMapDef(8, 'harbor', 2))).not.toEqual(a);
    expect(a.length).toBeGreaterThan(500);
  });

  test('quality scale thins the layout', () => {
    expect(placeDebris(defs[0], 0.35).length).toBeLessThan(placeDebris(defs[0]).length * 0.5);
  });

  test.each(defs.map((d) => [d.name, d.islands.length, d] as const))('%s ×%i: nothing floats, everything rests on ground', (_n, _c, def) => {
    for (const s of placeDebris(def)) {
      const g = groundAt(def, s.x, s.z);
      expect(g, `${s.kind} at ${s.x.toFixed(1)},${s.z.toFixed(1)}`).not.toBeNull();
      expect(s.y - DEBRIS_SPEC[s.kind].rest).toBeCloseTo(g!, 6);
    }
  });

  test.each(defs.map((d) => [d.name, d.islands.length, d] as const))('%s ×%i: clear of doorways, bunkers, stations, paths and cover', (_n, _c, def) => {
    for (const s of placeDebris(def)) {
      const isl = def.islands.find((i) => Math.hypot(s.x - i.center.x, s.z - i.center.z) <= i.radius);
      if (isl) {
        expect(blockedOnIsland(def, isl, s.x, s.z)).toBeNull();
        // explicit doorway check (independent of the helper)
        for (const d of isl.bunker.doorways) expect(Math.hypot(s.x - d.center.x, s.z - d.center.z)).toBeGreaterThan(d.width / 2 + 1);
        const b = isl.bunker.center;
        expect(Math.max(Math.abs(toLocal(isl, s.x, s.z).x - toLocal(isl, b.x, b.z).x), Math.abs(toLocal(isl, s.x, s.z).z - toLocal(isl, b.x, b.z).z)))
          .toBeGreaterThan(MAP.bunker.interior / 2 + MAP.bunker.wall);
        for (const key of ['generator', 'vault', 'shop'] as const) expect(Math.hypot(s.x - isl[key].x, s.z - isl[key].z)).toBeGreaterThan(1.2);
        const l = toLocal(isl, s.x, s.z);
        for (const p of ISLAND_DECOR.gravelPaths) for (const [px, pz] of p.pts) expect(Math.hypot(l.x - px, l.z - pz)).toBeGreaterThan(p.w / 2);
      } else if (Math.hypot(s.x - def.center.center.x, s.z - def.center.center.z) <= def.center.radius) {
        expect(blockedOnCenter(def, s.x, s.z)).toBeNull();
      }
    }
  });
});

describe('debris physics manager', () => {
  const def = defs[0];
  const isl = def.islands[0];
  const spawns = placeDebris(def);
  const focusOf = (x: number, z: number) => ({ x, y: isl.groundY + 1.6, z });

  test('props start frozen; an explosion wakes, flings and they settle back to sleep (frozen) on the ground', async () => {
    const sim = await DebrisSim.create(def, spawns, { cap: 150 });
    expect(sim.activeCount).toBe(0);
    const target = sim.nearest(isl.center.x, isl.center.z)!;
    const pos = { x: target.pose.x + 0.5, y: target.pose.y, z: target.pose.z };
    const start = { ...target.pose };
    sim.explosion(pos, 'grenade', focusOf(pos.x, pos.z));
    expect(sim.activeCount).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) sim.step(1 / 60, focusOf(pos.x, pos.z), [], MAP.waterY);
    expect(target.pose.y).toBeGreaterThan(start.y + 0.05); // airborne
    for (let i = 0; i < 60 * 12; i++) sim.step(1 / 60, focusOf(pos.x, pos.z), [], MAP.waterY);
    expect(sim.props.filter((p) => p.body && p.pose.y > MAP.waterY + 0.5).map((p) => [p.spawn.kind, p.pose.y.toFixed(2), p.body!.linvel().x.toFixed(2), JSON.stringify(p.body!.angvel()), p.sleepT, p.pose.x, p.pose.z])).toEqual([]); // all slept → frozen
    expect(sim.stats.frozen).toBeGreaterThan(0);
    sim.dispose();
  });

  test('active bodies never exceed the cap; nearer props win', async () => {
    const sim = await DebrisSim.create(def, spawns, { cap: 10 });
    const f = focusOf(isl.center.x, isl.center.z);
    sim.props.forEach((_, i) => sim.activate(i, f));
    expect(sim.activeCount).toBe(10);
    for (let k = 0; k < 30; k++) sim.step(1 / 60, f, [], MAP.waterY);
    expect(sim.activeCount).toBeLessThanOrEqual(10);
    // all awake bodies are among the nearest awake candidates: a near prop evicts a far one
    const dist = (p: { pose: { x: number; z: number } }) => Math.hypot(p.pose.x - f.x, p.pose.z - f.z);
    const far = [...sim.props].filter((p) => p.body).map(dist);
    const frozenNear = sim.props.find((p) => !p.body && dist(p) < Math.min(...far));
    if (frozenNear) expect(sim.activate(sim.props.indexOf(frozenNear), f)).toBe(true);
    expect(sim.activeCount).toBeLessThanOrEqual(10);
    sim.dispose();
  });

  test('a player walking into a prop shoves it', async () => {
    const sim = await DebrisSim.create(def, spawns);
    const p = sim.nearest(isl.center.x, isl.center.z)!;
    const start = { x: p.pose.x, z: p.pose.z };
    const g = p.pose.y - DEBRIS_SPEC[p.spawn.kind].rest;
    // walk through it along +x at 4 m/s
    for (let i = 0; i < 90; i++) {
      const x = start.x - 1.5 + (i / 60) * 4;
      sim.step(1 / 60, focusOf(x, start.z), [{ x, y: g, z: start.z }], MAP.waterY);
    }
    expect(Math.hypot(p.pose.x - start.x, p.pose.z - start.z)).toBeGreaterThan(0.2);
    sim.dispose();
  });

  test('shots knock props along the bullet', async () => {
    const sim = await DebrisSim.create(def, spawns);
    const p = sim.nearest(isl.center.x + 5, isl.center.z + 5)!;
    const x0 = p.pose.x;
    sim.shot({ x: p.pose.x - 20, y: p.pose.y, z: p.pose.z }, { x: p.pose.x + 20, y: p.pose.y, z: p.pose.z });
    for (let i = 0; i < 30; i++) sim.step(1 / 60, focusOf(p.pose.x, p.pose.z), [], MAP.waterY);
    expect(p.pose.x).toBeGreaterThan(x0 + 0.05);
    sim.dispose();
  });

  test('in the water, floaters bob at the surface and sinkers go down (and hide)', async () => {
    const water = { kind: 'buoy' as const, x: isl.center.x + (isl.radius + 6) * Math.sin(0.3), y: 2, z: isl.center.z + (isl.radius + 6) * Math.cos(0.3), yaw: 0, tint: 0 };
    const sinker = { ...water, kind: 'cone' as const, x: water.x + 1.2 };
    const sim = await DebrisSim.create(def, [water, sinker]);
    const f = focusOf(water.x, water.z);
    sim.activate(0, f); sim.activate(1, f);
    for (let i = 0; i < 60 * 15; i++) sim.step(1 / 60, f, [], MAP.waterY);
    expect(Math.abs(sim.props[0].pose.y - MAP.waterY)).toBeLessThan(0.35);
    expect(sim.props[0].body).not.toBeNull(); // floating: stays simulated
    expect(sim.props[1].sunk).toBe(true);
    sim.dispose();
  });

  test('displaced props respawn home once nobody is near, never in view', async () => {
    const sim = await DebrisSim.create(def, spawns, { respawnDist: 30 });
    const p = sim.nearest(isl.center.x, isl.center.z)!;
    const home = { x: p.spawn.x, y: p.spawn.y, z: p.spawn.z };
    const near = focusOf(home.x, home.z);
    sim.explosion({ x: home.x + 0.4, y: home.y, z: home.z }, 'grenade', near);
    for (let i = 0; i < 60 * 12; i++) sim.step(1 / 60, near, [], MAP.waterY);
    expect(p.moved).toBe(true);
    expect(p.body).toBeNull(); // settled + frozen
    const moved = { ...p.pose };
    for (let i = 0; i < 120; i++) sim.step(1 / 60, near, [], MAP.waterY); // still watched: stays put
    expect(p.pose.x).toBeCloseTo(moved.x, 3);
    const away = focusOf(home.x + 200, home.z);
    for (let i = 0; i < 120; i++) sim.step(1 / 60, away, [], MAP.waterY);
    expect(p.pose.x).toBe(home.x);
    expect(p.pose.y).toBe(home.y);
    expect(p.moved).toBe(false);
    expect(sim.stats.respawns).toBeGreaterThan(0);
    sim.dispose();
  });

  test('a removed piece drops what rested on it', async () => {
    const sim = await DebrisSim.create(def, [{ kind: 'box', x: isl.center.x, y: isl.groundY + 0.2 + DEBRIS_SPEC.box.rest, z: isl.center.z - 6, yaw: 0, tint: 0 }]);
    const piece = { id: 1, kind: 'scaffold' as const, owner: 1, pos: { x: isl.center.x, y: isl.groundY, z: isl.center.z - 6 }, rotY: 0, hp: 100 };
    sim.setPieces([piece]);
    sim.setPieces([]);
    expect(sim.activeCount).toBe(1);
    sim.dispose();
  });

  test('gameplay props are kinematic obstacles: debris rests on a crate and falls when it is pushed away', async () => {
    const x = isl.center.x, z = isl.center.z - 6, top = isl.groundY + 0.9;
    const sim = await DebrisSim.create(def, [{ kind: 'can', x, y: top + DEBRIS_SPEC.can.rest, z, yaw: 0, tint: 0 }]);
    sim.addObstacle(1, { box: { x: 0.45, y: 0.45, z: 0.45 } }, { x, y: isl.groundY + 0.45, z }, [0, 0, 0, 1]);
    const f = focusOf(x, z);
    sim.activate(0, f);
    for (let i = 0; i < 60; i++) sim.step(1 / 60, f, [], MAP.waterY);
    expect(sim.props[0].pose.y).toBeGreaterThan(top);
    for (let i = 1; i <= 5; i++) { // yanked out from under it (an explosion)
      sim.moveObstacle(1, { x: x + (i / 5) * 2, y: isl.groundY + 0.45, z }, [0, 0, 0, 1], f);
      sim.step(1 / 60, f, [], MAP.waterY);
    }
    for (let i = 0; i < 90; i++) sim.step(1 / 60, f, [], MAP.waterY);
    expect(sim.props[0].pose.y).toBeLessThan(isl.groundY + 0.2);
    sim.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import { buildMapDef } from '../../src/sim/map';
import { buildHabitats, type Habitats } from '../../src/client/world/critterHabitats';
import { type Agent, CritterSim, type View } from '../../src/client/world/critterSim';
import { SPECIES_DEFS } from '../../src/client/world/critterSpecies';

const def = buildMapDef(8, 'harbor', 1);
const hab = buildHabitats(def);
const rat = SPECIES_DEFS.find((d) => d.name === 'rat')!;
const pigeon = SPECIES_DEFS.find((d) => d.name === 'pigeon')!;

function view(cam: { x: number; y: number; z: number }, players: View['players'] = []): View {
  return { cam, fwd: { x: 0, y: 0, z: -1 }, players, visible: () => true, waterY: 0 };
}

/** A sim with one rat out and about at the first quay anchor, the camera next to it. */
function ratOut(): { sim: CritterSim; a: Agent; v: View } {
  const sim = new CritterSim(hab, 7, [rat]);
  const a = sim.spawn(rat, 0);
  const v = view({ x: a.x + 3, y: a.y + 2, z: a.z });
  a.st = 'idle'; a.t = 5; a.show = 1;
  return { sim, a, v };
}

describe('critter habitats', () => {
  it('places wildlife where the art is', () => {
    for (const h of ['quay', 'beach', 'rocks', 'shallows', 'water', 'perch', 'piling', 'palm', 'wall', 'trash', 'grass', 'flowers'] as const) {
      expect(hab[h].length, h).toBeGreaterThan(0);
    }
    // quays are on land, open-water anchors are not
    expect(hab.quay.every((a) => hab.land(a.x, a.z))).toBe(true);
    expect(hab.water.every((a) => !hab.land(a.x, a.z))).toBe(true);
    // wall panels stand upright with a unit normal
    for (const a of hab.wall) expect(Math.hypot(a.wall!.nx, a.wall!.nz)).toBeCloseTo(1, 5);
  });

  it('the Container Yard has no beach but containers to climb', () => {
    const yard: Habitats = buildHabitats(buildMapDef(4, 'yard', 3));
    expect(yard.beach.length).toBe(0);
    expect(yard.wall.length).toBeGreaterThan(0);
    expect(yard.containerTop.length).toBeGreaterThan(0);
  });
});

describe('critter behaviour', () => {
  it('a rat flees and hides when a player comes within 5 m', () => {
    const { sim, a, v } = ratOut();
    sim.update(0.05, v);
    expect(a.st === 'idle' || a.st === 'move').toBe(true);
    sim.update(0.05, { ...v, players: [{ x: a.x + 2, y: a.y, z: a.z }] });
    expect(a.st).toBe('flee');
    for (let i = 0; i < 60; i++) sim.update(0.05, { ...v, players: [{ x: a.x + 2, y: a.y, z: a.z }] });
    expect(a.st).toBe('hidden');
    expect(a.show).toBeLessThan(0.05);
  });

  it('a rat ignores a player 20 m away but flees a gunshot nearby', () => {
    const { sim, a, v } = ratOut();
    sim.update(0.05, { ...v, players: [{ x: a.x + 20, y: a.y, z: a.z }] });
    expect(a.st).not.toBe('flee');
    sim.noise('shot', [{ x: a.x + 8, y: a.y + 1.5, z: a.z }, { x: a.x + 30, y: a.y, z: a.z }]);
    sim.update(0.05, v);
    expect(a.st).toBe('flee');
  });

  it('pigeons burst into flight at an explosion', () => {
    const sim = new CritterSim(hab, 3, [pigeon]);
    const a = sim.spawn(pigeon, 0);
    sim.noise('explosion', [{ x: a.x + 15, y: a.y, z: a.z }]);
    sim.update(0.05, view({ x: a.x, y: a.y + 3, z: a.z + 4 }));
    expect(a.st).toBe('circle');
    expect(sim.sounds.some((s) => s.kind === 'flap')).toBe(true);
  });

  it('spawns only near the camera, within the preset cap, and despawns far away', () => {
    const sim = new CritterSim(hab, 11);
    const isl = def.islands[0];
    const cam = { x: isl.center.x, y: 4, z: isl.center.z };
    for (const q of ['low', 'high', 'ultra'] as const) {
      sim.quality = q;
      for (let i = 0; i < 20; i++) sim.update(0.1, view(cam));
      for (const d of SPECIES_DEFS) expect(sim.count(d.name), `${d.name} @ ${q}`).toBeLessThanOrEqual(d.cap[q]);
      for (const a of sim.agents) expect(Math.hypot(a.x - cam.x, a.z - cam.z)).toBeLessThan(a.def.spawnR * 1.35 + 30);
    }
    expect(sim.count('rat')).toBeGreaterThan(0);
    sim.quality = 'high';
    // fly the camera far out to sea: everything near the old spot goes
    for (let i = 0; i < 10; i++) sim.update(0.1, view({ x: 5000, y: 4, z: 5000 }));
    expect(sim.agents.map((a) => `${a.def.name}:${a.st}:${Math.round(a.x)}`)).toEqual([]);
  });

  it('off-screen agents are paused', () => {
    const { sim, a, v } = ratOut();
    const before = { x: a.x, z: a.z, st: a.st, t: a.t };
    for (let i = 0; i < 20; i++) sim.update(0.1, { ...v, visible: () => false, players: [{ x: a.x, y: a.y, z: a.z }] });
    expect({ x: a.x, z: a.z, st: a.st, t: a.t }).toEqual(before);
  });

  it('is deterministic per seed', () => {
    const run = (seed: number) => {
      const sim = new CritterSim(hab, seed);
      const isl = def.islands[1];
      const cam = { x: isl.center.x + 5, y: 4, z: isl.center.z };
      for (let i = 0; i < 200; i++) {
        if (i === 80) sim.noise('shot', [{ x: cam.x, y: 3, z: cam.z }]);
        sim.update(1 / 30, view(cam, [{ x: cam.x + Math.sin(i / 20) * 10, y: 2, z: cam.z }]));
      }
      return sim.agents.map((a) => [a.def.name, a.st, a.x.toFixed(4), a.z.toFixed(4)].join()).join('|');
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
  });
});

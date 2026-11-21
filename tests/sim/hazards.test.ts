import { describe, expect, test } from 'vitest';
import { CRATE_LOOT, HAZARD, PLAYER, WEAPONS } from '../../src/sim/constants';
import { crateLoot, hazardSpotProblem, noBuildZones, rayCylinder } from '../../src/sim/hazards';
import { buildMapDef, MAP_TEMPLATES, type HazardDef } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { NO_INPUT, type PlayerInput, type Snapshot, type Vec3 } from '../../src/sim/types';
import { dist2D, v3 } from '../../src/sim/vec';
import { SnapshotEncoder } from '../../src/net/snapshotCodec';
import { WireDecoder, WireEncoder } from '../../src/net/wire';
import { newPlayer } from '../../src/sim/player';

async function match(n = 2, map: 'harbor' | 'yard' = 'harbor', seed = 1) {
  return Match.create({ players: Array.from({ length: n }, (_, i) => ({ name: `p${i + 1}`, isBot: false })), map, seed });
}
const tick = (m: Match, sec: number, inputs = new Map<number, PlayerInput>()) => {
  let s: Snapshot = m.tick(inputs);
  const all: Snapshot[] = [s];
  for (let i = 1; i < Math.round(sec * 30); i++) { s = m.tick(inputs); all.push(s); }
  return { last: s, events: all.flatMap((x) => x.events), all };
};
/** Out of spawn protection, standing at `pos`. */
function place(m: Match, id: number, pos: Vec3) {
  m.debugTeleport(id, pos);
  const p = (m as unknown as { s: { players: Map<number, { invulnUntil: number; spawnProtected?: boolean }> } }).s.players.get(id)!;
  p.invulnUntil = 0;
  p.spawnProtected = false;
}
/** Aim from a player's eye at a point. */
function aimAt(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const eye = v3(from.x, from.y + PLAYER.eyeHeight, from.z);
  const dx = to.x - eye.x, dy = to.y - eye.y, dz = to.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}
/** A point `d` m from `h` on the side toward the island centre (on open ground). */
function beside(m: Match, h: HazardDef, d: number): Vec3 {
  const c = h.island >= 0 ? m.def.islands[h.island].center : m.def.center.center;
  const l = dist2D(c, h.pos) || 1;
  return v3(h.pos.x + ((c.x - h.pos.x) / l) * d, h.pos.y, h.pos.z + ((c.z - h.pos.z) / l) * d);
}
const firstOf = (m: Match, kind: HazardDef['kind'], island = 0) => m.def.hazards.find((h) => h.kind === kind && h.island === island)!;
const hpOf = (m: Match, id: number) => m.debugHazards().find((h) => h.id === id)!;

describe('map placement', () => {
  test('every map has a few barrels/tanks and 2-3 crates per island, plus some on the center island', () => {
    for (const t of MAP_TEMPLATES) for (let n = 2; n <= 8; n++) {
      const def = buildMapDef(n, t);
      for (let i = -1; i < n; i++) {
        const here = def.hazards.filter((h) => h.island === i);
        const crates = here.filter((h) => h.kind === 'crate').length;
        expect(crates, `${t} ${n}p island ${i}`).toBeGreaterThanOrEqual(2);
        expect(crates).toBeLessThanOrEqual(3);
        expect(here.length - crates).toBeGreaterThanOrEqual(2);
      }
      expect(new Set(def.hazards.map((h) => h.id)).size).toBe(def.hazards.length);
    }
  });

  test('no hazard in a bunker, doorway, no-build zone, station, cover or the water', () => {
    for (const t of MAP_TEMPLATES) for (let n = 2; n <= 8; n++) {
      const def = buildMapDef(n, t);
      for (const h of def.hazards) expect(hazardSpotProblem(def, h.pos, h.kind), `${t} ${n}p hazard ${h.id} (${h.kind}, island ${h.island})`).toBeNull();
    }
  });

  test('the spot check does catch bad spots', () => {
    const def = buildMapDef(4, 'harbor');
    const isl = def.islands[0];
    expect(hazardSpotProblem(def, isl.bunker.center, 'barrel')).toMatch(/bunker/);
    expect(hazardSpotProblem(def, isl.generator, 'crate')).toMatch(/station/);
    const door = isl.bunker.doorways[0].center;
    const out = v3(door.x + (door.x - isl.bunker.center.x) * 0.9, door.y, door.z + (door.z - isl.bunker.center.z) * 0.9);
    expect(hazardSpotProblem(def, out, 'barrel')).toMatch(/bunker|doorway|no-build/);
    expect(hazardSpotProblem(def, noBuildZones(isl)[0].center, 'crate')).not.toBeNull();
  });
});

describe('explosive barrels', () => {
  test('shot to 0 hp: fuses for ~1 s, then explodes and damages players inside the radius only', async () => {
    const m = await match(3);
    const b = firstOf(m, 'barrel');
    const R = HAZARD.barrel.radius;
    place(m, 1, beside(m, b, 9));                 // the shooter, outside the blast
    const toward = beside(m, b, 1);
    place(m, 2, v3(b.pos.x - (toward.z - b.pos.z) * 2, b.pos.y, b.pos.z + (toward.x - b.pos.x) * 2)); // inside, off the line of fire
    // outside: off the line of fire, toward the island middle, R + 2 from the barrel
    const far = beside(m, b, R + 2);
    place(m, 3, v3(far.x - (toward.z - b.pos.z) * 1.5, far.y, far.z + (toward.x - b.pos.x) * 1.5));
    m.debugGive(1, { weapons: { rifle: { mag: 25, spare: 0 } } });
    const center = v3(b.pos.x, b.pos.y + HAZARD.barrel.h / 2, b.pos.z);
    const fire = { ...NO_INPUT, ...aimAt(beside(m, b, 9), center), fire: true, ads: true };
    m.tick(new Map([[1, { ...NO_INPUT, slot: 'rifle' }]]));
    // Rifle: 30 per hit, barrel 50 hp: two hits.
    const shots: Snapshot[] = [];
    for (let i = 0; i < 90 && hpOf(m, b.id).st === 0; i++) shots.push(m.tick(new Map([[1, fire]])));
    const fuse = shots.flatMap((s) => s.events).find((e) => e.type === 'hazard' && e.data.what === 'fuse');
    expect(fuse?.data.by).toBe(1);
    const fusedAt = shots[shots.length - 1].time;
    expect(hpOf(m, b.id).st).toBe(1);
    // Nothing blows before the fuse is up.
    const { all } = tick(m, HAZARD.fuseSec + 0.2);
    const boom = all.find((s) => s.events.some((e) => e.type === 'explosion' && e.data.hazard === b.id))!;
    expect(boom.time - fusedAt).toBeCloseTo(HAZARD.fuseSec, 1);
    const hits = boom.events.filter((e) => e.type === 'hit' && e.data.weapon === 'barrel');
    expect(hits.map((e) => e.data.target)).toContain(2);
    expect(hits.map((e) => e.data.target)).not.toContain(3);
    expect(hits.map((e) => e.data.target)).not.toContain(1);
    expect(boom.players[1].hp).toBeLessThan(PLAYER.hp);
    expect(boom.players[2].hp).toBe(PLAYER.hp);
    expect(hpOf(m, b.id).st).toBe(2);
  });

  test('shield soaks the blast first', async () => {
    const m = await match(2);
    const b = firstOf(m, 'barrel');
    place(m, 2, beside(m, b, 1.5));
    m.debugSetShield(2, 100);
    m.debugDamageHazard(b.id, 1, 1, 'explosive');
    const s = m.tick(new Map());
    const hit = s.events.find((e) => e.type === 'hit' && e.data.target === 2)!;
    expect(hit.data.shieldAmount).toBeGreaterThan(0);
    expect(s.players[1].hp).toBe(PLAYER.hp);
    expect(s.players[1].shield).toBeLessThan(100);
  });

  test('a blast sets off hazards in range: chain reaction with a delay per link', async () => {
    const m = await match(2);
    const pair = m.def.hazards.filter((h) => h.island === 0 && h.kind !== 'crate')
      .find((a) => m.def.hazards.some((o) => o !== a && o.kind !== 'crate' && dist2D(o.pos, a.pos) < HAZARD.barrel.radius - 1))!;
    expect(pair).toBeDefined();
    m.debugDamageHazard(pair.id, 1, 1, 'explosive'); // instant: blows this tick
    const { all } = tick(m, 1);
    const booms = all.flatMap((s) => s.events.filter((e) => e.type === 'explosion').map((e) => ({ t: e.t, id: e.data.hazard as number, by: e.data.by })));
    expect(booms[0].id).toBe(pair.id);
    expect(booms.length).toBeGreaterThanOrEqual(2);
    expect(booms[1].t - booms[0].t).toBeCloseTo(HAZARD.chainSec, 1);
    expect(booms.every((b) => b.by === 1)).toBe(true);
  });

  test('grenades / rockets set them off at once (no fuse)', async () => {
    const m = await match(2);
    const b = firstOf(m, 'barrel');
    place(m, 1, beside(m, b, 8));
    m.debugGive(1, { weapons: { rocket: { mag: 1, spare: 0 } } });
    m.tick(new Map([[1, { ...NO_INPUT, slot: 'rocket' }]]));
    const aim = aimAt(beside(m, b, 8), v3(b.pos.x, b.pos.y + 0.4, b.pos.z));
    const { all } = tick(m, 1, new Map([[1, { ...NO_INPUT, ...aim, fire: true }]]));
    const rocket = all.find((s) => s.events.some((e) => e.type === 'explosion' && e.data.kind === 'rocket'))!;
    expect(rocket).toBeDefined();
    expect(rocket.events.some((e) => e.type === 'explosion' && e.data.hazard === b.id)).toBe(true);
  });

  test('kills are credited to whoever set it off, "via barrel"', async () => {
    const m = await match(2);
    const b = firstOf(m, 'barrel');
    place(m, 2, beside(m, b, 1));
    m.debugSetHp(2, 20);
    m.debugDamageHazard(b.id, HAZARD.barrel.hp, 1);
    const { events, last } = tick(m, HAZARD.fuseSec + 0.2);
    const kill = events.find((e) => e.type === 'kill')!;
    expect(kill.data).toMatchObject({ victim: 2, killer: 1, via: 'barrel' });
    expect(last.players[0].kills).toBe(1);
  });

  test('respawns after 90 s, only once nobody is within 15 m', async () => {
    const m = await match(2);
    const b = firstOf(m, 'barrel');
    m.debugDamageHazard(b.id, 1, null, 'explosive');
    tick(m, 0.2);
    expect(hpOf(m, b.id).st).toBe(2);
    place(m, 1, beside(m, b, 8)); // close by
    tick(m, HAZARD.barrel.respawnSec);
    expect(hpOf(m, b.id).st).toBe(2);
    place(m, 1, m.def.islands[1].center);
    const { events } = tick(m, 0.2);
    expect(hpOf(m, b.id)).toMatchObject({ st: 0, hp: HAZARD.barrel.hp });
    expect(events.some((e) => e.type === 'hazard' && e.data.what === 'respawn' && e.data.id === b.id)).toBe(true);
  });

  test('fists do nothing to a barrel; bullets stop at it', async () => {
    const m = await match(2);
    const b = firstOf(m, 'barrel');
    const stand = beside(m, b, 1.2);
    place(m, 1, stand);
    const aim = aimAt(stand, v3(b.pos.x, b.pos.y + 0.5, b.pos.z));
    tick(m, 2, new Map([[1, { ...NO_INPUT, ...aim, fire: true }]]));
    expect(hpOf(m, b.id)).toMatchObject({ st: 0, hp: HAZARD.barrel.hp });
    expect(rayCylinder(v3(0, 1, -5), v3(0, 0, 1), v3(0, 0, 0), 0.3, 1, 10)).toBeCloseTo(4.7, 5);
    expect(rayCylinder(v3(0, 5, 0), v3(0, -1, 0), v3(0, 0, 0), 0.3, 1, 10)).toBeCloseTo(4, 5);
    expect(rayCylinder(v3(1, 1, -5), v3(0, 0, 1), v3(0, 0, 0), 0.3, 1, 10)).toBeNull();
  });
});

describe('supply crates', () => {
  test('loot table: deterministic, weights hold, cash $20-80, ammo only for an owned gun', () => {
    expect(crateLoot(0.1, 0.5, 'smg')).toEqual(crateLoot(0.1, 0.5, 'smg'));
    const N = 20000, counts: Record<string, number> = {};
    let cash = 0, cashN = 0;
    for (let i = 0; i < N; i++) {
      const u1 = (i + 0.5) / N, u2 = ((i * 7919) % N) / N;
      const d = crateLoot(u1, u2, 'pistol');
      counts[d.what] = (counts[d.what] ?? 0) + 1;
      if (d.what === 'cash') {
        expect(d.inv.cash).toBeGreaterThanOrEqual(CRATE_LOOT.cash.min);
        expect(d.inv.cash).toBeLessThanOrEqual(CRATE_LOOT.cash.max);
        cash += d.inv.cash; cashN++;
      }
      if (d.what === 'ammo') expect(d.inv.weapons.pistol).toEqual({ mag: 0, spare: WEAPONS.pistol.mag });
    }
    const W = CRATE_LOOT.weights, total = W.ammo + W.medkit + W.cash + W.grenade + W.sandbags;
    for (const k of Object.keys(W) as (keyof typeof W)[]) expect(counts[k] / N).toBeCloseTo(W[k] / total, 2);
    expect(cash / cashN).toBeCloseTo(50, 0);
    // No gun: the ammo share turns into cash.
    expect(crateLoot(0.01, 0.5, null).what).toBe('cash');
    expect(crateLoot(0.01, 0.5, 'rocket').inv.weapons.rocket).toEqual({ mag: 0, spare: CRATE_LOOT.rockets });
  });

  test('breaking a crate (shots or punches) drops a loot bag where it stood; same seed, same loot', async () => {
    const drops: unknown[] = [];
    for (const seed of [7, 7]) {
      const m = await match(2, 'harbor', seed);
      const c = firstOf(m, 'crate');
      const stand = beside(m, c, 1.1);
      place(m, 1, stand);
      const aim = aimAt(stand, v3(c.pos.x, c.pos.y + 0.4, c.pos.z));
      const { events, last } = tick(m, 3, new Map([[1, { ...NO_INPUT, ...aim, fire: true }]]));
      const br = events.find((e) => e.type === 'hazard' && e.data.what === 'break')!;
      expect(br.data).toMatchObject({ id: c.id, by: 1 });
      expect(hpOf(m, c.id).st).toBe(2);
      // The bag landed on the crate spot (it may already be picked up: the breaker stands next to it).
      const bagEvents = last.loot.filter((l) => dist2D(l.pos, c.pos) < 0.01);
      drops.push(br.data.loot);
      expect(bagEvents.length + (last.players[0].inv.cash > 50 || last.players[0].inv.medkits > 0 || last.players[0].inv.grenades > 0 || (last.players[0].inv.pieces.sandbags ?? 0) > 0 ? 1 : 0)).toBeGreaterThan(0);
    }
    expect(drops[0]).toBe(drops[1]);
  });

  test('ammo-only drops: only someone who owns the gun picks them up', async () => {
    const m = await match(2);
    const c = firstOf(m, 'crate');
    // Force an ammo roll: try breaks until one is ammo (deterministic per seed).
    m.debugGive(1, { weapons: { smg: { mag: 30, spare: 0 } } });
    let bag: Snapshot['loot'][number] | undefined;
    for (let k = 0; k < 40 && !bag; k++) {
      const before = new Set(m.tick(new Map()).loot.map((l) => l.id));
      m.debugDamageHazard(c.id, 1000, 1);
      const s = m.tick(new Map());
      bag = s.loot.find((l) => !before.has(l.id) && l.ammoOnly);
      // respawn it for the next try
      (m as unknown as { hazards: { list: { st: number; hp: number; goneAt: number }[] } }).hazards.list.find((h) => h.st === 2)!.goneAt = -1e9;
      place(m, 1, m.def.islands[1].center); place(m, 2, m.def.islands[1].center);
      m.tick(new Map());
    }
    expect(bag).toBeDefined();
    expect(bag!.inv.weapons.smg).toEqual({ mag: 0, spare: 30 });
    // p2 has no smg: walks over it, nothing happens.
    place(m, 2, bag!.pos);
    let s = m.tick(new Map());
    expect(s.loot.some((l) => l.id === bag!.id)).toBe(true);
    expect(s.players[1].inv.weapons.smg).toBeUndefined();
    place(m, 2, m.def.islands[1].center);
    place(m, 1, bag!.pos);
    s = m.tick(new Map());
    expect(s.loot.some((l) => l.id === bag!.id)).toBe(false);
    expect(s.players[0].inv.weapons.smg!.spare).toBe(30);
  });

  test('crates respawn after ~120 s', async () => {
    const m = await match(2);
    const c = firstOf(m, 'crate');
    place(m, 1, m.def.islands[1].center); place(m, 2, m.def.islands[1].center);
    m.debugDamageHazard(c.id, 1000, null);
    tick(m, HAZARD.crate.respawnSec - 1);
    expect(hpOf(m, c.id).st).toBe(2);
    tick(m, 1.2);
    expect(hpOf(m, c.id).st).toBe(0);
  });
});

describe('snapshot', () => {
  test('quiet map: no hazard state at all; changed ones only', async () => {
    const m = await match(8);
    expect(m.tick(new Map()).hz).toBeUndefined();
    const b = firstOf(m, 'barrel');
    m.debugDamageHazard(b.id, 10, 1);
    expect(m.tick(new Map()).hz).toEqual([{ id: b.id, st: 0, hp: HAZARD.barrel.hp - 10 }]);
  });

  test('8-player budget holds with every hazard on the map damaged or gone', () => {
    const def = buildMapDef(8, 'harbor');
    const enc = new SnapshotEncoder(), wire = new WireEncoder(), dec = new WireDecoder();
    const players = Array.from({ length: 8 }, (_, i) => newPlayer(i + 1, 'p' + i, true, i, v3(i * 10.123456, 2, 3.333333)));
    const hz = def.hazards.map((h, i) => ({ id: h.id, st: (i % 3) as 0 | 1 | 2, hp: i % 3 ? 0 : 17 }));
    const s: Snapshot = {
      time: 1 / 30, tick: 1, players, pieces: Array.from({ length: 60 }, (_, i) => ({ id: i, kind: 'steel', owner: 1, pos: v3(1, 2, 3), rotY: 0.5, hp: 1200 })),
      loot: [], generators: players.map((_, i) => ({ island: i, stored: 3 })), genLevels: players.map(() => 1), sealed: players.map(() => false),
      waterY: 0, suddenDeath: false, winner: null, events: [], projectiles: [], hz,
    };
    enc.push(s);
    const json = enc.take(1);
    expect(json.hz).toEqual(hz);
    const full = wire.encode(1, enc.take(1, true));
    expect(full.byteLength).toBeLessThan(6 * 1024);
    dec.decode(full);
    wire.ack(dec.ack);
    for (const p of players) p.pos = v3(p.pos.x + 0.17, p.pos.y, p.pos.z - 0.11);
    enc.push({ ...s, tick: 2, time: 2 / 30 });
    const delta = wire.encode(2, enc.take(1, true));
    expect(delta.byteLength).toBeLessThan((20 * 1024) / 30);
    const out = dec.decode(delta)!;
    expect(out).toBeTruthy();
  });
});

describe('bots and hazards', () => {
  /** A bot with a rifle 14 m from a barrel; the human stands right next to the barrel. */
  async function duel(difficulty: 'easy' | 'pro', seed: number) {
    const m = await Match.create({ players: [{ name: 'me', isBot: false }, { name: 'Bot', isBot: true, difficulty }], seed });
    const b = firstOf(m, 'barrel', 0);
    place(m, 1, beside(m, b, 1.0));
    m.debugGive(2, { weapons: { rifle: { mag: 25, spare: 100 } } });
    place(m, 2, beside(m, b, 14));
    let barrelBy: unknown = null;
    for (let i = 0; i < 30 * 12 && barrelBy === null; i++) {
      if (i % 30 === 0) place(m, 1, beside(m, b, 1.0)); // the human holds still next to it
      m.debugSetHp(1, 100);
      const s = m.tick(new Map());
      for (const e of s.events) if (e.type === 'hazard' && e.data.what === 'fuse' && e.data.id === b.id) barrelBy = e.data.by;
    }
    return barrelBy;
  }

  test('pro bots sometimes shoot the barrel next to an enemy; easy bots never do', async () => {
    let pro = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) if ((await duel('pro', seed)) === 2) pro++;
    expect(pro).toBeGreaterThan(0);
    for (const seed of [1, 2, 3]) expect(await duel('easy', seed)).not.toBe(2);
  });

  test('in a fight, a bot steps out of blast range of a barrel and stays out; anyone runs from a fusing one', async () => {
    for (const fusing of [false, true]) for (const seed of [1, 2, 4]) {
      const m = await Match.create({ players: [{ name: 'me', isBot: false }, { name: 'Bot', isBot: true, difficulty: 'hard' }], seed });
      const b = firstOf(m, 'barrel', 0);
      place(m, 2, beside(m, b, 0.8));
      if (fusing) { place(m, 1, m.def.islands[1].center); m.debugDamageHazard(b.id, HAZARD.barrel.hp, 1); }
      else { place(m, 1, beside(m, b, 16)); m.debugGive(2, { weapons: { pistol: { mag: 12, spare: 24 } } }); }
      tick(m, 1);
      const { all } = tick(m, fusing ? 0.4 : 1);
      const closest = Math.min(...all.map((s) => dist2D(s.players[1].pos, b.pos)));
      expect(closest, `${fusing ? 'fusing' : 'fight'} seed ${seed}`).toBeGreaterThan(fusing ? HAZARD.barrel.radius * 0.5 : 2.5);
    }
  });

  test('a bot breaks a supply crate it is standing near when nothing else is going on', async () => {
    let broke = 0;
    for (const seed of [1, 2, 3, 4]) {
      const m = await Match.create({ players: [{ name: 'me', isBot: false }, { name: 'Bot', isBot: true, difficulty: 'hard' }], seed });
      const c = firstOf(m, 'crate', 1);
      place(m, 1, m.def.islands[0].center);
      place(m, 2, beside(m, c, 4));
      m.debugGive(2, { weapons: { pistol: { mag: 12, spare: 24 } } });
      const { events } = tick(m, 10);
      if (events.some((e) => e.type === 'hazard' && e.data.what === 'break' && e.data.id === c.id && e.data.by === 2)) broke++;
    }
    expect(broke).toBeGreaterThan(1);
  });
});

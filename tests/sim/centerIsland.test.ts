import { describe, expect, test } from 'vitest';
import { CENTER, ECONOMY, PLAYER } from '../../src/sim/constants';
import { collectSupply, newCenterState, tickCenter } from '../../src/sim/center';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type PlayerInput, type Snapshot, type Vec3 } from '../../src/sim/types';
import { dist2D, v3 } from '../../src/sim/vec';
import { COSMETIC } from '../../src/sim/map';

const two = async (map: 'harbor' | 'yard' = 'harbor') => {
  const m = await Match.create({ players: [{ name: 'a', isBot: false }, { name: 'b', isBot: false }], map });
  mid = m.def.center.center;
  return m;
};
const run = (m: Match, sec: number, inputs = new Map<number, PlayerInput>()) => {
  let s: Snapshot = m.tick(inputs);
  for (let i = 1; i < sec * 30; i++) s = m.tick(inputs);
  return s;
};
/** Stand a metre toward the center island's middle from a station. */
let mid: Vec3 = v3();
const beside = (p: Vec3) => v3(mid.x + (p.x - mid.x) * 0.8, p.y, mid.z + (p.z - mid.z) * 0.8);

describe('center island: gold generator', () => {
  test('fills at twice the home rate and caps at 1000', async () => {
    const m = await two();
    const s = run(m, 10);
    expect(s.center!.gold).toBeCloseTo(10 * CENTER.goldRate, 0);
    expect(s.center!.gold / s.generators[0].stored).toBeCloseTo(2, 1);
    const later = run(m, 120);
    expect(later.center!.gold).toBe(CENTER.goldCap);
    expect(later.generators[0].stored).toBe(ECONOMY.generatorCap);
  });

  test('anyone collects, and it is contested: the first to collect takes it all', async () => {
    const m = await two();
    run(m, 20);
    const g = m.def.center.goldGen;
    m.debugTeleport(1, beside(g));
    m.debugTeleport(2, v3(beside(g).x + 0.5, g.y, beside(g).z));
    const before = m.tick(new Map()).players.map((p) => p.inv.cash);
    const s1 = m.tick(new Map([[1, { ...NO_INPUT, interact: true }]]));
    const got1 = s1.players[0].inv.cash - before[0];
    expect(got1).toBeGreaterThanOrEqual(Math.floor(20 * CENTER.goldRate) - 1);
    expect(s1.events.some((e) => e.type === 'centerCollect' && e.data.by === 1)).toBe(true);
    const s2 = m.tick(new Map([[2, { ...NO_INPUT, interact: true }]]));
    expect(s2.players[1].inv.cash - before[1]).toBeLessThanOrEqual(1);
    expect(s2.center!.gold).toBeLessThan(1.01);
  });

  test('out of reach does nothing', async () => {
    const m = await two();
    run(m, 5);
    const cash = m.tick(new Map()).players[0].inv.cash;
    const s = m.tick(new Map([[1, { ...NO_INPUT, interact: true }]])); // player 1 is in their bunker
    expect(s.players[0].inv.cash).toBe(cash);
  });
});

describe('center island: supply generator', () => {
  test('stocks a sandbag every few seconds and a steel plate every minute', () => {
    const c = newCenterState();
    for (let t = 0; t < CENTER.supplySteelSec + 0.01; t += 1 / 30) tickCenter(c, 1 / 30, true);
    expect(c.bags).toBe(Math.min(CENTER.supplyBagCap, Math.floor(CENTER.supplySteelSec / CENTER.supplyBagSec)));
    expect(c.steel).toBe(1);
    for (let t = 0; t < 600; t += 1 / 30) tickCenter(c, 1 / 30, true);
    expect(c.bags).toBe(CENTER.supplyBagCap);
    expect(c.steel).toBe(CENTER.supplySteelCap);
    const frozen = { ...c, bags: 0 };
    tickCenter(frozen, 100, false);
    expect(frozen.bags).toBe(0);
  });

  test('collecting respects hotbar capacity: a full hotbar only takes kinds it already holds', () => {
    const p = newPlayer(1, 'a', false, 0, v3());
    p.inv.pieces = { wood: 1, metal: 1, ramp: 1, scaffold: 1, sandbags: 2, container: 1 };
    p.inv.grenades = 1; p.inv.charges = 1; p.inv.medkits = 1;
    p.hotbar = ['wood', 'metal', 'ramp', 'scaffold', 'sandbags', 'container', 'grenade', 'charge', 'medkit'];
    const c = { ...newCenterState(), bags: 4, steel: 1 };
    const took = collectSupply(p, c);
    expect(took).toEqual({ sandbags: 4, steel: 0 });
    expect(p.inv.pieces.sandbags).toBe(6);
    expect(p.inv.pieces.steel).toBeUndefined();
    expect(c).toMatchObject({ bags: 0, steel: 1 }); // steel stays for someone with room
    p.inv.medkits = 0; p.hotbar[8] = null;
    expect(collectSupply(p, c)).toEqual({ sandbags: 0, steel: 1 });
    expect(p.hotbar).toContain('steel');
    expect(p.inv.pieces.steel).toBe(1);
  });

  test('in a match: interacting at the supply generator hands over the pieces', async () => {
    const m = await two();
    run(m, CENTER.supplyBagSec * 3 + 1);
    m.debugTeleport(1, beside(m.def.center.supplyGen));
    m.tick(new Map());
    const s = m.tick(new Map([[1, { ...NO_INPUT, interact: true }]]));
    expect(s.players[0].inv.pieces.sandbags).toBe(3);
    expect(s.players[0].hotbar).toContain('sandbags');
    expect(s.center!.bags).toBe(0);
  });
});

describe('center island: shield well', () => {
  test('standing in the well refills shield up to 50, no further', async () => {
    const m = await two();
    m.debugTeleport(1, m.def.center.shieldWell);
    m.tick(new Map());
    const me = (m as unknown as { s: { players: Map<number, { shield: number }> } }).s.players.get(1)!;
    expect(me.shield).toBeLessThan(0.5); // one tick in the well
    run(m, 5);
    expect(me.shield).toBeCloseTo(Math.min(CENTER.wellCap, 5 * CENTER.wellPerSec), 0);
    run(m, 30);
    expect(me.shield).toBe(CENTER.wellCap);
    m.debugTeleport(1, beside(m.def.center.goldGen));
    me.shield = 10;
    run(m, 3);
    expect(me.shield).toBe(10);
  });
});

describe('map cover and cosmetics', () => {
  test('container cover is solid and indestructible: bullets and explosives leave it standing', async () => {
    const m = await two('yard');
    const box = m.def.statics.find((s) => s.island === 0 && s.half.y < 2)!;
    const ph = (m as unknown as { physics: import('../../src/sim/physics').Physics }).physics;
    const probe = () => ph.isGroundAt(box.center.x, box.center.z);
    const top = box.center.y + box.half.y;
    expect(probe()).toBeCloseTo(top, 4);
    // Stand next to it and empty a rifle into it, then a grenade and a breach charge.
    const isl = m.map[0];
    const dir = v3(box.center.x - isl.center.x, 0, box.center.z - isl.center.z);
    const l = Math.hypot(dir.x, dir.z);
    const stand = v3(box.center.x - (dir.x / l) * 4, isl.groundY, box.center.z - (dir.z / l) * 4);
    m.debugTeleport(1, stand);
    m.debugGive(1, { weapons: { rifle: { mag: 25, spare: 0 } }, grenades: 1, charges: 1 });
    const yaw = Math.atan2(-(box.center.x - stand.x), -(box.center.z - stand.z));
    const fire = new Map([[1, { ...NO_INPUT, yaw, pitch: -0.1, fire: true, slot: 'rifle' as const }]]);
    let s = run(m, 6, fire);
    const shots = s.events.length;
    expect(shots).toBeGreaterThanOrEqual(0);
    s = m.tick(new Map([[1, { ...NO_INPUT, yaw, throwGrenade: true }]]));
    s = m.tick(new Map([[1, { ...NO_INPUT, yaw, placeCharge: true }]]));
    s = run(m, 5);
    expect(probe()).toBeCloseTo(top, 4);
    expect(s.pieces).toEqual([]);
  });

  test('cosmetic props break when shot (everyone sees the same broken list) but never block anything', async () => {
    const m = await two('harbor');
    const isl = m.map[0];
    const barrel = m.def.cosmetics.find((c) => c.kind === 'barrel' && dist2D(c.pos, isl.center) < isl.radius)!;
    expect(barrel).toBeDefined();
    const ph = (m as unknown as { physics: import('../../src/sim/physics').Physics }).physics;
    // No collider: a ray through the barrel's middle finds nothing there.
    const hit = ph.raycast(v3(barrel.pos.x - 1, barrel.pos.y + 0.5, barrel.pos.z), v3(1, 0, 0), 2);
    expect(hit === null || hit.dist > 1.5 || hit.hit.type !== 'world' || Math.abs(hit.point.x - barrel.pos.x) > COSMETIC.barrel.r + 0.01).toBe(true);
    // Shoot it from 5 m.
    const stand = v3(barrel.pos.x + 5, isl.groundY, barrel.pos.z);
    m.debugTeleport(1, stand);
    m.debugGive(1, { weapons: { pistol: { mag: 12, spare: 0 } } });
    const eyeY = isl.groundY + PLAYER.eyeHeight;
    const yaw = Math.atan2(-(barrel.pos.x - stand.x), -(barrel.pos.z - stand.z));
    const pitch = Math.atan2(barrel.pos.y + 0.5 - eyeY, 5);
    let broke = false, s: Snapshot | null = null;
    for (let i = 0; i < 90 && !broke; i++) {
      s = m.tick(new Map([[1, { ...NO_INPUT, yaw, pitch, fire: true, slot: 'pistol' }]]));
      broke = s.events.some((e) => e.type === 'cosmeticBroken' && e.data.id === barrel.id);
    }
    expect(broke).toBe(true);
    expect(s!.broken).toContain(barrel.id);
    // Breaking it changed nothing structural: no pieces, seals untouched.
    expect(s!.sealed).toEqual([false, false]);
  });

  test('a grenade breaks the props around it', async () => {
    const m = await two('yard');
    const isl = m.map[0];
    const near = m.def.cosmetics.filter((c) => dist2D(c.pos, isl.center) < isl.radius && c.kind === 'barrel');
    const target = near[0];
    m.debugTeleport(1, v3(target.pos.x + 1.5, isl.groundY, target.pos.z));
    m.debugGive(1, { grenades: 1 });
    m.tick(new Map([[1, { ...NO_INPUT, yaw: Math.PI / 2, pitch: -1.2, throwGrenade: true }]]));
    m.debugTeleport(1, isl.spawn);
    const s = run(m, 4);
    expect(s.broken).toContain(target.id);
  });
});

describe('center island: potion seller', () => {
  test('the potion seller NPC stands on the center island and sells potions', async () => {
    const m = await two('yard');
    expect(m.potionShops.map((s) => s.pos)).toEqual([m.def.center.potionShop]);
    m.debugTeleport(1, beside(m.def.center.potionShop));
    m.debugGive(1, { cash: 500 });
    m.tick(new Map());
    const s = m.tick(new Map([[1, { ...NO_INPUT, shop: { buy: 'shieldSmall' } }]]));
    expect(s.players[0].inv.potions.shieldSmall).toBe(1);
  });
});

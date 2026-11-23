import { beforeAll, describe, expect, test } from 'vitest';
import { LIFECYCLE } from '../../src/sim/constants';
import { buy, vaultTransfer } from '../../src/sim/economy';
import { killPlayer, newMatchState, tickLifecycle } from '../../src/sim/lifecycle';
import { buildMap, type IslandLayout } from '../../src/sim/map';
import { Match } from '../../src/sim/match';
import { Physics } from '../../src/sim/physics';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type HotbarItem, type PlayerInput, type PlayerState } from '../../src/sim/types';
import { add, dist2D, forward, right, scale, v3 } from '../../src/sim/vec';
import { unarmed } from './unarmed';

const humans1v1 = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
const inputs = (id: number, i: Partial<PlayerInput>) => new Map([[id, { ...NO_INPUT, ...i }]]);
const player = (cash = 0) => {
  const p = newPlayer(1, 'p', false, 0, v3());
  p.inv.cash = cash;
  return p;
};
const fill = (p: PlayerState, kinds: HotbarItem[]) => {
  for (const k of kinds) {
    p.inv.cash += 1000;
    const r = buy(p, { buy: k });
    if (!r.ok) throw new Error(`fill: ${k}: ${r.reason}`);
  }
};
const NINE: HotbarItem[] = ['pistol', 'smg', 'shotgun', 'rifle', 'sandbags', 'wood', 'metal', 'steel', 'scaffold'];

describe('hotbar: buying', () => {
  test('a bought item lands in the first empty slot', () => {
    const p = player(300);
    expect(buy(p, { buy: 'pistol' }).ok).toBe(true);
    expect(buy(p, { buy: 'wood' }).ok).toBe(true);
    expect(buy(p, { buy: 'wood' }).ok).toBe(true);
    expect(buy(p, { buy: 'grenade' }).ok).toBe(true);
    expect(p.hotbar.slice(0, 4)).toEqual(['pistol', 'wood', 'grenade', null]);
  });

  test('a full hotbar rejects a new kind without taking money', () => {
    const p = player();
    fill(p, NINE);
    p.inv.cash = 500;
    const r = buy(p, { buy: 'charge' });
    expect(r).toEqual({ ok: false, reason: 'Hotbar full' });
    expect(p.inv.cash).toBe(500);
    expect(p.inv.charges).toBe(0);
  });

  test('a full hotbar still stacks a kind already held, and ammo needs no slot', () => {
    const p = player();
    fill(p, NINE);
    p.inv.cash = 500;
    p.equipped = 'pistol';
    expect(buy(p, { buy: 'wood' }).ok).toBe(true);
    expect(p.inv.pieces.wood).toBe(2);
    expect(buy(p, { buy: 'ammo' }).ok).toBe(true);
  });
});

describe('hotbar: vault', () => {
  test('deposit of the last unit frees the slot; withdraw puts it back', () => {
    const p = player(300);
    buy(p, { buy: 'pistol' });
    buy(p, { buy: 'steel' });
    expect(p.hotbar.slice(0, 2)).toEqual(['pistol', 'steel']);
    expect(vaultTransfer(p, { deposit: { weapons: { pistol: { mag: 0, spare: 0 } }, pieces: { steel: 1 } } }).ok).toBe(true);
    expect(p.hotbar.every((k) => k === null)).toBe(true);
    expect(vaultTransfer(p, { withdraw: { pieces: { steel: 1 } } }).ok).toBe(true);
    expect(p.hotbar[0]).toBe('steel');
  });

  test('withdraw of a new kind needs a free slot', () => {
    const p = player();
    fill(p, NINE);
    p.vault.charges = 1;
    p.vault.pieces.wood = 2;
    const r = vaultTransfer(p, { withdraw: { charges: 1 } });
    expect(r).toEqual({ ok: false, reason: 'Hotbar full' });
    expect(p.vault.charges).toBe(1);
    expect(vaultTransfer(p, { withdraw: { pieces: { wood: 2 } } }).ok).toBe(true);
    expect(p.inv.pieces.wood).toBe(3);
  });

  test('swapping a gun for a new kind in one transfer fits', () => {
    const p = player();
    fill(p, NINE);
    p.vault.charges = 1;
    expect(vaultTransfer(p, { deposit: { weapons: { rifle: { mag: 0, spare: 0 } } }, withdraw: { charges: 1 } }).ok).toBe(true);
    expect(p.hotbar).toContain('charge');
    expect(p.hotbar).not.toContain('rifle');
  });
});

describe('hotbar: death and loot', () => {
  let map: IslandLayout[];
  beforeAll(() => { map = buildMap(2); });
  const spot = (island: number, d: number) => {
    const i = map[island];
    const p = add(add(i.center, scale(forward(i.bunker.facingYaw), d)), scale(right(i.bunker.facingYaw), 3));
    return v3(p.x, i.groundY, p.z);
  };
  async function setup() {
    const physics = await Physics.create(map);
    const s = newMatchState(map);
    const a = newPlayer(1, 'a', false, 0, map[0].spawn);
    const b = newPlayer(2, 'b', false, 1, map[1].spawn);
    for (const p of [a, b]) { s.players.set(p.id, p); physics.addPlayer(p.id, p.pos); }
    return { s, physics, a, b };
  }

  test('death clears the hotbar with the inventory', async () => {
    const { s, physics, b } = await setup();
    b.pos = spot(1, 5);
    fill(b, ['smg', 'wood']);
    b.selected = 0;
    b.equipped = 'smg';
    killPlayer(s, physics, 2, 0, false);
    expect(b.hotbar.every((k) => k === null)).toBe(true);
    expect(b.equipped).toBe('fists');
  });

  test('loot pickup merges into the hotbar; kinds that do not fit stay in the bag', async () => {
    const { s, physics, a, b } = await setup();
    fill(a, NINE.slice(0, 8)); // one free slot
    a.pos = spot(1, 5);
    b.pos = spot(1, 5);
    fill(b, ['grenade', 'charge', 'wood']);
    b.inv.cash = 40;
    killPlayer(s, physics, 2, 0, false);
    const cashBefore = a.inv.cash;
    tickLifecycle(s, physics, map, 0.1, 1 / 30);
    // wood stacks onto a's existing slot, grenade takes the last free slot, charge doesn't fit.
    expect(a.inv.pieces.wood).toBe(2);
    expect(a.inv.grenades).toBe(1);
    expect(a.inv.charges).toBe(0);
    expect(a.inv.cash).toBe(cashBefore + 40);
    expect(a.hotbar[8]).toBe('grenade');
    const bags = [...s.loot.values()];
    expect(bags).toHaveLength(1);
    expect(bags[0].inv.charges).toBe(1);
    expect(bags[0].inv.cash).toBe(0);
    // The leftover bag doesn't flicker: a stays next to it and nothing changes.
    tickLifecycle(s, physics, map, 0.2, 1 / 30);
    expect(s.loot.size).toBe(1);
  });
});

describe('hotbar: in a match', () => {
  async function atShop() {
    const m = await Match.create(humans1v1);
    const yaw = m.map[0].bunker.facingYaw;
    m.debugTeleport(1, add(m.map[0].shop, scale(forward(yaw), 1.5)));
    return m;
  }
  const me = (snap: { players: PlayerState[] }) => snap.players[0];

  test('select decides what is in hand', async () => {
    const m = await atShop();
    m.debugGive(1, { cash: 500 });
    let snap = m.tick(inputs(1, { shop: { buy: 'pistol' } }));
    expect(me(snap).hotbar[0]).toBe('pistol');
    snap = m.tick(inputs(1, { shop: { buy: 'wood' } }));
    expect(me(snap).hotbar[1]).toBe('wood');
    snap = m.tick(inputs(1, { select: 0 }));
    expect(me(snap).selected).toBe(0);
    expect(me(snap).equipped).toBe('pistol');
    snap = m.tick(inputs(1, { select: 1 }));
    expect(me(snap).equipped).toBe('fists');
    snap = m.tick(inputs(1, { select: 5 }));
    expect(me(snap).equipped).toBe('fists');
    snap = m.tick(inputs(1, { select: 0 }));
    expect(me(snap).equipped).toBe('pistol');
  });

  test('legacy slot selects the hotbar slot holding that gun (bots)', async () => {
    const m = await atShop();
    unarmed(m);
    m.debugGive(1, { cash: 500 });
    m.tick(inputs(1, { shop: { buy: 'wood' } }));
    m.tick(inputs(1, { shop: { buy: 'smg' } }));
    let snap = m.tick(inputs(1, { moveSlot: { from: 1, to: 6 } }));
    expect(me(snap).hotbar[6]).toBe('smg');
    snap = m.tick(inputs(1, { slot: 'smg' }));
    expect(me(snap).selected).toBe(6);
    expect(me(snap).equipped).toBe('smg');
    snap = m.tick(inputs(1, { slot: 'fists' }));
    expect(me(snap).equipped).toBe('fists');
    snap = m.tick(inputs(1, { slot: 'rifle' })); // not owned: ignored
    expect(me(snap).equipped).toBe('fists');
  });

  test('reorder swaps two slots and keeps the selection index', async () => {
    const m = await atShop();
    m.debugGive(1, { cash: 500 });
    m.tick(inputs(1, { shop: { buy: 'pistol' } }));
    m.tick(inputs(1, { shop: { buy: 'grenade' } }));
    let snap = m.tick(inputs(1, { select: 0, moveSlot: { from: 0, to: 1 } }));
    expect(me(snap).hotbar.slice(0, 2)).toEqual(['grenade', 'pistol']);
    expect(me(snap).equipped).toBe('fists');
    snap = m.tick(inputs(1, { moveSlot: { from: 1, to: 1 } }));
    expect(me(snap).hotbar.slice(0, 2)).toEqual(['grenade', 'pistol']);
  });

  test('drop one: gun with its ammo goes into a bag in front; the slot frees', async () => {
    const m = await atShop();
    unarmed(m);
    m.debugGive(1, { cash: 500 });
    m.tick(inputs(1, { shop: { buy: 'pistol' } }));
    let snap = m.tick(inputs(1, { select: 0 }));
    expect(me(snap).equipped).toBe('pistol');
    const yaw = me(snap).yaw;
    snap = m.tick(inputs(1, { select: 0, yaw, drop: 'one' }));
    expect(me(snap).hotbar[0]).toBeNull();
    expect(me(snap).inv.weapons.pistol).toBeUndefined();
    expect(me(snap).equipped).toBe('fists');
    expect(snap.loot).toHaveLength(1);
    expect(snap.loot[0].inv.weapons.pistol).toEqual({ mag: 12, spare: 36 });
    expect(snap.loot[0].inv.cash).toBe(0);
    const d = dist2D(snap.loot[0].pos, me(snap).pos);
    expect(d).toBeGreaterThan(LIFECYCLE.lootPickupRadius);
    expect(d).toBeLessThan(2.5);
  });

  test('drop one piece vs the whole stack', async () => {
    const m = await atShop();
    unarmed(m);
    m.debugGive(1, { pieces: { wood: 3 } });
    let snap = m.tick(inputs(1, { select: 0 }));
    expect(me(snap).hotbar[0]).toBe('wood');
    snap = m.tick(inputs(1, { select: 0, drop: 'one' }));
    expect(me(snap).inv.pieces.wood).toBe(2);
    expect(me(snap).hotbar[0]).toBe('wood');
    expect(snap.loot[0].inv.pieces.wood).toBe(1);
    snap = m.tick(inputs(1, { select: 0, drop: 'stack' }));
    expect(me(snap).inv.pieces.wood ?? 0).toBe(0);
    expect(me(snap).hotbar[0]).toBeNull();
    expect(snap.loot).toHaveLength(2);
    expect(snap.loot[1].inv.pieces.wood).toBe(2);
    // Dropping from an empty slot does nothing.
    snap = m.tick(inputs(1, { select: 0, drop: 'stack' }));
    expect(snap.loot).toHaveLength(2);
  });

  test('the dropper cannot re-pick a bag for 1.5 s; others can right away', async () => {
    const m = await atShop();
    unarmed(m);
    m.debugGive(1, { grenades: 2 });
    let snap = m.tick(inputs(1, { select: 0, drop: 'one' }));
    const bag = snap.loot[0];
    m.debugTeleport(1, bag.pos);
    for (let i = 0; i < 30; i++) snap = m.tick(new Map());
    expect(snap.loot).toHaveLength(1);
    expect(me(snap).inv.grenades).toBe(1);
    for (let i = 0; i < 20; i++) snap = m.tick(new Map());
    expect(snap.loot).toHaveLength(0);
    expect(me(snap).inv.grenades).toBe(2);

    snap = m.tick(inputs(1, { select: 0, drop: 'one' }));
    m.debugTeleport(2, snap.loot[0].pos);
    snap = m.tick(new Map());
    expect(snap.loot).toHaveLength(0);
    expect(snap.players[1].inv.grenades).toBe(1);
    expect(snap.players[1].hotbar).toContain('grenade');
  });

  test('using up the last piece frees its slot', async () => {
    const m = await Match.create(humans1v1);
    unarmed(m);
    const isl = m.map[0];
    const yaw = isl.bunker.facingYaw;
    const stand = add(add(isl.center, scale(forward(yaw), 4)), scale(right(yaw), 3));
    m.debugTeleport(1, v3(stand.x, isl.groundY, stand.z));
    m.debugGive(1, { pieces: { sandbags: 1 } });
    const target = add(stand, scale(forward(yaw), 3));
    const req = { kind: 'sandbags' as const, pos: v3(target.x, isl.groundY, target.z), rotY: yaw, free: false };
    let snap = m.tick(inputs(1, { select: 0 }));
    expect(me(snap).hotbar[0]).toBe('sandbags');
    snap = m.tick(inputs(1, { select: 0, build: req }));
    expect(snap.pieces).toHaveLength(1);
    expect(me(snap).hotbar[0]).toBeNull();
  });

  test('throwing the last grenade frees its slot', async () => {
    const m = await atShop();
    unarmed(m);
    m.debugGive(1, { grenades: 1 });
    let snap = m.tick(inputs(1, { select: 0, throwGrenade: true }));
    expect(me(snap).inv.grenades).toBe(0);
    expect(me(snap).hotbar[0]).toBeNull();
  });

  test('a debug kill clears the hotbar', async () => {
    const m = await atShop();
    unarmed(m);
    m.debugGive(1, { pieces: { wood: 2 }, grenades: 1 });
    let snap = m.tick(new Map());
    expect(me(snap).hotbar.filter(Boolean)).toHaveLength(2);
    m.debugKill(1);
    snap = m.tick(new Map());
    expect(me(snap).hotbar.every((k) => k === null)).toBe(true);
  });
});

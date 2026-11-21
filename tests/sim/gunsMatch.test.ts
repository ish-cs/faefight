import { describe, expect, test } from 'vitest';
import { AMMO_BOX, ECONOMY, PLAYER, SPARE_MAGS_ON_BUY, WEAPONS } from '../../src/sim/constants';
import { buy } from '../../src/sim/economy';
import { Match } from '../../src/sim/match';
import { newPlayer } from '../../src/sim/player';
import { NO_INPUT, type PlayerInput, type Snapshot } from '../../src/sim/types';
import { sanitizeInput } from '../../src/net/sanitize';
import { v3 } from '../../src/sim/vec';

const humans = { players: [{ name: 'you', isBot: false }, { name: 'friend', isBot: false }] };
const inputs = (i: Partial<PlayerInput>) => new Map([[1, { ...NO_INPUT, ...i }]]);
const me = (s: Snapshot) => s.players.find((p) => p.id === 1)!;

async function match() {
  const m = await Match.create(humans);
  let s = m.tick(new Map());
  const c = m.map[0].center; // open ground (you spawn under the bunker roof)
  m.debugTeleport(1, v3(c.x + 3, m.map[0].groundY, c.z + 3));
  for (let i = 0; i < 10; i++) s = m.tick(new Map()); // settle on the ground
  return { m, s };
}

describe('shop + hotbar: rocket launcher', () => {
  test('costs $500, lands in the hotbar with 1 loaded and 3 spare', () => {
    const p = newPlayer(1, 'p', false, 0, v3());
    p.inv.cash = 600;
    expect(buy(p, { buy: 'rocket' }).ok).toBe(true);
    expect(p.inv.cash).toBe(100);
    expect(p.inv.weapons.rocket).toEqual({ mag: 1, spare: SPARE_MAGS_ON_BUY });
    expect(p.hotbar[0]).toBe('rocket');
  });
  test('an ammo box with the launcher in hand is one rocket at the rocket price', () => {
    const p = newPlayer(1, 'p', false, 0, v3());
    p.inv.cash = WEAPONS.rocket.price + AMMO_BOX.rocketPrice;
    buy(p, { buy: 'rocket' });
    p.equipped = 'rocket';
    expect(buy(p, { buy: 'ammo' }).ok).toBe(true);
    expect(p.inv.weapons.rocket!.spare).toBe(SPARE_MAGS_ON_BUY + AMMO_BOX.rockets);
    expect(p.inv.cash).toBe(0);
    expect(buy(p, { buy: 'ammo' }).ok).toBe(false);
  });
  test('start cash cannot buy it', () => {
    expect(ECONOMY.startCash).toBeLessThan(WEAPONS.rocket.price);
  });
});

describe('match: aiming, rockets, projectiles', () => {
  test('ADS needs a gun, slows you down and is cleared by a reload', async () => {
    const { m } = await match();
    let s = m.tick(inputs({ ads: true, moveZ: 1 }));
    expect(me(s).ads).toBe(false); // fists
    m.debugGive(1, { weapons: { rifle: { mag: 20, spare: 50 } } });
    s = m.tick(inputs({ select: 0, ads: true, moveZ: 1 }));
    expect(me(s).equipped).toBe('rifle');
    expect(me(s).ads).toBe(true);
    expect(Math.hypot(me(s).vel.x, me(s).vel.z)).toBeCloseTo(PLAYER.walk * WEAPONS.rifle.adsMove, 1);
    s = m.tick(inputs({ select: 0, ads: true, moveZ: 1, sprint: true }));
    expect(Math.hypot(me(s).vel.x, me(s).vel.z)).toBeCloseTo(PLAYER.walk * WEAPONS.rifle.adsMove, 1); // no sprinting in sights
    s = m.tick(inputs({ select: 0, ads: true, reload: true }));
    expect(me(s).reloadUntil).toBeGreaterThan(0);
    s = m.tick(inputs({ select: 0, ads: true }));
    expect(me(s).ads).toBe(false);
  });
  test('a rocket in flight is in the snapshot; a rocket jump lifts you off the ground', async () => {
    const { m } = await match();
    m.debugGive(1, { weapons: { rocket: { mag: 1, spare: 3 } } });
    let s = m.tick(inputs({ select: 0, pitch: 0.4 }));
    s = m.tick(inputs({ select: 0, pitch: 0.4, fire: true }));
    expect(s.projectiles!.map((p) => p.kind)).toEqual(['rocket']);
    expect(s.events.find((e) => e.type === 'shot')!.data.weapon).toBe('rocket');
    for (let i = 0; i < 100; i++) s = m.tick(inputs({ select: 0 }));
    expect(s.projectiles).toEqual([]);

    // Reloaded: now at your feet.
    const y0 = me(s).pos.y;
    s = m.tick(inputs({ select: 0, pitch: -1.4, fire: true }));
    let top = y0;
    for (let i = 0; i < 20; i++) { s = m.tick(inputs({ select: 0, pitch: -1.4 })); top = Math.max(top, me(s).pos.y); }
    expect(top - y0).toBeGreaterThan(1.5);
    expect(me(s).alive).toBe(true);
    expect(me(s).hp).toBeLessThan(100);
  });
  test('grenades show up as projectiles too', async () => {
    const { m } = await match();
    m.debugGive(1, { grenades: 1 });
    const s = m.tick(inputs({ throwGrenade: true }));
    expect(s.projectiles!.map((p) => p.kind)).toEqual(['grenade']);
  });
});

describe('sanitize', () => {
  test('ads is a strict boolean; the rocket is a valid shop item and slot', () => {
    expect(sanitizeInput({ ...NO_INPUT, ads: true })!.ads).toBe(true);
    expect(sanitizeInput({ ...NO_INPUT, ads: 'yes' })!.ads).toBe(false);
    expect(sanitizeInput({ ...NO_INPUT, ads: undefined })!.ads).toBe(false);
    expect(sanitizeInput({ ...NO_INPUT, shop: { buy: 'rocket' } })!.shop).toEqual({ buy: 'rocket' });
    expect(sanitizeInput({ ...NO_INPUT, slot: 'rocket' })!.slot).toBe('rocket');
    expect(sanitizeInput({ ...NO_INPUT, shop: { buy: 'nuke' } })!.shop).toBeNull();
  });
});

describe('match: host /money path', () => {
  test('debugGive({ cash }) adds to cash on hand and nothing else', async () => {
    const { m, s } = await match();
    const before = me(s);
    m.debugGive(1, { cash: 500 });
    const after = me(m.tick(new Map()));
    expect(after.inv.cash).toBe(before.inv.cash + 500);
    expect(after.inv.weapons).toEqual(before.inv.weapons);
  });
});

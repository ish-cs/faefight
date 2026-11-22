import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { WEAPONS } from '../../src/sim/constants';
import { NO_INPUT, type PlayerState, type Snapshot } from '../../src/sim/types';

const idle = { makeBot: () => ({ think: () => NO_INPUT }) };
const tick1 = (m: Match): Snapshot => m.tick(new Map([[1, NO_INPUT]]));
const armed = (p: PlayerState) => {
  expect(p.inv.weapons.pistol, `${p.name} holds a pistol`).toEqual({ mag: WEAPONS.pistol.mag, spare: WEAPONS.pistol.mag });
  expect(p.hotbar.filter((k) => k === 'pistol')).toHaveLength(1);
};
const inHand = (p: PlayerState) => {
  expect(p.hotbar[p.selected], `${p.name}'s selected slot`).toBe('pistol');
  expect(p.equipped).toBe('pistol');
};

describe('everyone starts the match with a pistol in hand', () => {
  test('free-for-all: humans and bots, 8 players', async () => {
    const players = [{ name: 'You', isBot: false }, ...Array.from({ length: 7 }, (_, i) => ({ name: `B${i}`, isBot: true }))];
    const s = tick1(await Match.create({ players, seed: 3 }, idle));
    expect(s.players).toHaveLength(8);
    for (const p of s.players) { armed(p); inHand(p); }
  });

  test('teams', async () => {
    const players = [{ name: 'A', isBot: false, team: 0 }, { name: 'B', isBot: true, team: 0 }, { name: 'C', isBot: true, team: 1 }, { name: 'D', isBot: true, team: 1 }];
    const s = tick1(await Match.create({ players, seed: 4, settings: { teamMode: 2 } }, idle));
    for (const p of s.players) { armed(p); inHand(p); }
  });

  test('practice: the human has a pistol (after the build slots); dummies stay unarmed except the shooter', async () => {
    const s = tick1(await Match.create({ players: [{ name: 'You', isBot: false }], practice: true }));
    const me = s.players.find((p) => p.id === 1)!;
    expect(me.inv.weapons.pistol).toBeDefined();
    expect(me.hotbar.slice(0, 7)).toEqual(['rifle', 'smg', 'shotgun', 'wood', 'metal', 'ramp', 'pistol']);
    for (const d of s.players.filter((p) => p.id !== 1 && p.alive))
      expect(Object.keys(d.inv.weapons).every((w) => w === 'pistol')).toBe(true);
  });

  test('the shop does not sell a second pistol', async () => {
    const m = await Match.create({ players: [{ name: 'You', isBot: false }, { name: 'Bot', isBot: true }] }, idle);
    const me0 = tick1(m).players.find((p) => p.id === 1)!;
    const shop = m.map[me0.island].shop;
    m.debugTeleport(1, { x: shop.x + 1, y: shop.y, z: shop.z });
    const s = m.tick(new Map([[1, { ...NO_INPUT, shop: { buy: 'pistol' } }]]));
    const me = s.players.find((p) => p.id === 1)!;
    expect(me.inv.cash).toBe(me0.inv.cash);
    expect(me.hotbar.filter((k) => k === 'pistol')).toHaveLength(1);
  });

  test('clicking at tick 1 fires the pistol', async () => {
    const m = await Match.create({ players: [{ name: 'You', isBot: false }, { name: 'Bot', isBot: true }], seed: 5 }, idle);
    const s = m.tick(new Map([[1, { ...NO_INPUT, fire: true }]]));
    expect(s.players.find((p) => p.id === 1)!.inv.weapons.pistol!.mag).toBe(WEAPONS.pistol.mag - 1);
  });
});

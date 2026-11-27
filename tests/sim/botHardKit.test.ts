import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { DRIVE, PARAM_RANGES, VAULT } from '../../src/sim/bots/params';
import { nextPurchase, PLAIN_STYLE } from '../../src/sim/bots/plans';
import { PIECES } from '../../src/sim/constants';
import { newPlayer } from '../../src/sim/player';
import type { Difficulty } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';
import type { Doorway } from '../../src/sim/map';

// A gun-upgraded bot whose kit is three wood plugs (a full kit by count): the only thing left to buy is metal.
const woodKit = (cash: number) => {
  const p = newPlayer(1, 'p', false, 0, v3());
  p.inv.cash = cash;
  p.inv.weapons.rifle = { mag: 25, spare: 75 };
  p.inv.weapons.smg = { mag: 30, spare: 90 };
  p.equipped = 'rifle';
  p.inv.pieces.wood = 3;
  return p;
};
const needs = (d: Difficulty) => ({ scaffolds: 0, kit: 3, charge: false, hardKit: DRIVE.hardKit[d] });

describe('drive.hardKit: the seal kit is metal, not wood (a respawn pistol shoots wood out in ~7 s)', () => {
  test('Hard/PRO swap a wood kit for metal as soon as one metal plug is affordable', () => {
    for (const d of ['hard', 'pro'] as const) expect(nextPurchase(woodKit(PIECES.metal.price), needs(d), d, PLAIN_STYLE)).toBe('metal');
  });
  test('Medium/Easy keep their wood kit (knob 0: tier order holds); a Medium knob of 2 waits for twice the price', () => {
    expect(nextPurchase(woodKit(5000), needs('medium'), 'medium', PLAIN_STYLE)).not.toBe('metal');
    const m2 = { ...needs('medium'), hardKit: 2 };
    expect(nextPurchase(woodKit(PIECES.metal.price), m2, 'medium', PLAIN_STYLE)).not.toBe('metal');
    expect(nextPurchase(woodKit(2 * PIECES.metal.price), m2, 'medium', PLAIN_STYLE)).toBe('metal');
    expect(nextPurchase(woodKit(5000), needs('easy'), 'easy', PLAIN_STYLE)).not.toBe('metal');
  });
  test('stops once the metal/steel plugs cover the doors', () => {
    const p = woodKit(5000);
    p.inv.pieces.metal = 2; p.inv.pieces.steel = 1;
    expect(nextPurchase(p, needs('pro'), 'pro', PLAIN_STYLE)).not.toBe('metal');
  });
  test('the bot passes its tier knob to the shop, and the knob is tunable', () => {
    const b = new Bot(1, 'pro', () => 0.5) as unknown as { P: { drive: { hardKit: Record<Difficulty, number> } } };
    expect(b.P.drive.hardKit.pro).toBe(DRIVE.hardKit.pro);
    expect(DRIVE.hardKit.easy).toBe(0);
    expect(PARAM_RANGES['drive.hardKit.pro']).toEqual([0, 4]);
  });
});

describe('drive.reinforceHp: a sieger adds a second wall outside the softest plug', () => {
  const door = { center: v3(0, 0, 0), yaw: 0, width: 2 } as unknown as Doorway;
  const ctx = (pieces: Record<string, number>) => ({
    me: { pos: v3(0, 0, 2.5), inv: { pieces }, busyUntil: 0 },
    view: { now: 10, canPlace: () => ({ ok: true }) },
  }) as never;
  const bot = (d: Difficulty) => {
    const b = new Bot(1, d, () => 0.5) as unknown as { goTo: () => unknown; reinforce: (c: never, d: Doorway, hp: number) => { build?: { kind: string } } | null };
    b.goTo = () => ({ dir: null });
    return b;
  };
  test('Medium+ stack a wall (strongest carried) on a lone wood plug', () => {
    expect(bot('pro').reinforce(ctx({ wood: 1, metal: 1 }), door, PIECES.wood.hp)?.build?.kind).toBe('metal');
    expect(bot('hard').reinforce(ctx({ wood: 1 }), door, PIECES.sandbags.hp * 2)?.build?.kind).toBe('wood');
    expect(bot('medium').reinforce(ctx({ wood: 1 }), door, PIECES.wood.hp)?.build?.kind).toBe('wood');
  });
  test('not once the doorway holds enough hp, without a wall, or for Easy', () => {
    expect(bot('pro').reinforce(ctx({ wood: 1 }), door, DRIVE.reinforceHp.pro)).toBeNull();
    expect(bot('pro').reinforce(ctx({ sandbags: 4 }), door, PIECES.wood.hp)).toBeNull();
    expect(bot('easy').reinforce(ctx({ wood: 1 }), door, PIECES.wood.hp)).toBeNull();
    expect(PARAM_RANGES['drive.reinforceHp.pro']).toEqual([0, 1000]);
  });
});

describe('vault.upgradeNear: a rich bot at the shop buys its vault level on the same trip', () => {
  test('the knob is on and tunable (behaviour: tests/sim/botVault.test.ts)', () => {
    expect(VAULT.upgradeNear).toBeGreaterThan(0);
    expect(PARAM_RANGES['vault.upgradeNear']).toEqual([0, 1]);
  });
});

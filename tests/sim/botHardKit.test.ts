import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { DRIVE, PARAM_RANGES } from '../../src/sim/bots/params';
import { nextPurchase, PLAIN_STYLE } from '../../src/sim/bots/plans';
import { PIECES } from '../../src/sim/constants';
import { newPlayer } from '../../src/sim/player';
import type { Difficulty } from '../../src/sim/types';
import { v3 } from '../../src/sim/vec';

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
  test('Medium only with twice the price; Easy never (tier order holds)', () => {
    expect(nextPurchase(woodKit(PIECES.metal.price), needs('medium'), 'medium', PLAIN_STYLE)).not.toBe('metal');
    expect(nextPurchase(woodKit(2 * PIECES.metal.price), needs('medium'), 'medium', PLAIN_STYLE)).toBe('metal');
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

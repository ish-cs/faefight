import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { DRIVE } from '../../src/sim/bots/params';
import { mulberry32 } from '../../src/sim/rng';

// Ctx stub: only what kitlessAttack reads.
const ctx = (o: { pieces?: Record<string, number>; cash?: number; sealed?: boolean; doors?: number; sd?: boolean }) => ({
  rivalIsl: { index: 1 },
  openDoors: Array(o.doors ?? 3).fill({}),
  me: { inv: { pieces: o.pieces ?? {}, cash: o.cash ?? 500 }, vault: { cash: 0 } },
  view: { sealed: [false, o.sealed ?? false], suddenDeath: o.sd ?? false },
}) as never;

describe('drive.kitlessAttack: no attack on an unsealed rival without a seal kit I could buy', () => {
  // The shop plan stubbed: by default it would sell a plug next.
  const bot = (d: 'easy' | 'medium' | 'hard' | 'pro', items: string[] = ['wood']) => {
    const b = new Bot(1, d, mulberry32(1));
    (b as unknown as { plan: () => unknown }).plan = () => ({ items, covered: false, spent: 0 });
    return b;
  };
  test('short of a kit with the cash for it: attack is marked down by the tier knob', () => {
    expect(bot('pro').kitlessAttack(ctx({}))).toBe(DRIVE.kitlessAttack.pro);
    expect(bot('medium').kitlessAttack(ctx({ pieces: { wood: 2 } }))).toBe(DRIVE.kitlessAttack.medium);
  });
  test('no penalty with a full kit, a sealed rival, sudden death, no money, or for easy', () => {
    expect(bot('pro').kitlessAttack(ctx({ pieces: { wood: 3 } }))).toBe(0);
    expect(bot('pro').kitlessAttack(ctx({ pieces: { wood: 1 }, doors: 1 }))).toBe(0);
    expect(bot('pro').kitlessAttack(ctx({ sealed: true }))).toBe(0);
    expect(bot('pro').kitlessAttack(ctx({ sd: true }))).toBe(0);
    expect(bot('pro').kitlessAttack(ctx({ cash: 20 }))).toBe(0);
    expect(bot('easy').kitlessAttack(ctx({}))).toBe(0);
  });
  test('no penalty when the shop would not sell a plug now (full hotbar: nothing to go and buy)', () => {
    expect(bot('pro', []).kitlessAttack(ctx({}))).toBe(0);
    expect(bot('pro', ['scaffold', 'smg']).kitlessAttack(ctx({}))).toBe(0);
    expect(bot('pro', ['scaffold', 'metal']).kitlessAttack(ctx({}))).toBe(DRIVE.kitlessAttack.pro);
  });
});

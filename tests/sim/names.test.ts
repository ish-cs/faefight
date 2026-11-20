import { describe, expect, test } from 'vitest';
import { Match } from '../../src/sim/match';
import { isPlaceholderBotName, nickname } from '../../src/sim/names';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('bot nicknames', () => {
  test('seeded, unique, short, varied styles', () => {
    const roll = (seed: number) => { const taken = new Set<string>(); const r = mulberry32(seed); return Array.from({ length: 8 }, () => nickname(r, taken)); };
    expect(roll(5)).toEqual(roll(5));
    const many = Array.from({ length: 30 }, (_, i) => roll(i)).flat();
    for (const n of many) { expect(n.length).toBeLessThan(16); expect(n).toMatch(/^[A-Za-z0-9_.]+$/); }
    for (let i = 0; i < 30; i++) expect(new Set(roll(i).map((n) => n.toLowerCase())).size).toBe(8);
    expect(many.some((n) => n.includes('_'))).toBe(true);
    expect(many.some((n) => n === n.toLowerCase())).toBe(true);
    expect(many.some((n) => /\d/.test(n))).toBe(true);
  });

  test('placeholder bot names get a nickname; real names are kept', async () => {
    expect(isPlaceholderBotName('Bot (hard)')).toBe(true);
    expect(isPlaceholderBotName('Bot (easy) 2')).toBe(true); // extra debug/test bots get numbered
    expect(isPlaceholderBotName('Bot 7')).toBe(true);
    expect(isPlaceholderBotName('')).toBe(true);
    expect(isPlaceholderBotName('Bobby')).toBe(false);
    const m = await Match.create({ players: [
      { name: 'You', isBot: false }, { name: 'Bot (hard)', isBot: true, difficulty: 'hard' }, { name: 'friend', isBot: true, difficulty: 'easy' },
    ], seed: 4 });
    const names = m.tick(new Map()).players.map((p) => p.name);
    expect(names[0]).toBe('You');
    expect(names[1]).not.toMatch(/bot|hard/i);
    expect(names[2]).toBe('friend');
  });
});

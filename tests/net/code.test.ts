import { describe, expect, test } from 'vitest';
import { newInviteCode, normalizeCode } from '../../src/net/code';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

describe('newInviteCode', () => {
  test('6 chars from the alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const c = newInviteCode();
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  test('uses the injected rng, including the edges 0 and ~1', () => {
    expect(newInviteCode(() => 0)).toBe('AAAAAA');
    expect(newInviteCode(() => 0.9999999999)).toBe('999999');
    let i = 0;
    expect(newInviteCode(() => (i++ % ALPHABET.length) / ALPHABET.length)).toBe('ABCDEF');
  });

  test('rng returning exactly 1 still stays in the alphabet', () => {
    expect(newInviteCode(() => 1)).toBe('999999');
  });
});

describe('normalizeCode', () => {
  test('uppercases and strips spaces and dashes', () => {
    expect(normalizeCode('k7q2mx')).toBe('K7Q2MX');
    expect(normalizeCode(' K7Q-2MX ')).toBe('K7Q2MX');
    expect(normalizeCode('k7 q2 m x')).toBe('K7Q2MX');
  });

  test('rejects wrong length or chars outside the alphabet', () => {
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('K7Q2M')).toBeNull();
    expect(normalizeCode('K7Q2MXA')).toBeNull();
    expect(normalizeCode('K7Q2M0')).toBeNull(); // 0 not in alphabet
    expect(normalizeCode('K7Q2MI')).toBeNull(); // I
    expect(normalizeCode('K7Q2ML')).toBeNull(); // L
    expect(normalizeCode('K7Q2MO')).toBeNull(); // O
    expect(normalizeCode('K7Q2M1')).toBeNull(); // 1
    expect(normalizeCode('K7Q2M!')).toBeNull();
  });

  test('round-trips generated codes', () => {
    for (let i = 0; i < 50; i++) {
      const c = newInviteCode();
      expect(normalizeCode(c.toLowerCase())).toBe(c);
    }
  });
});

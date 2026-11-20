import { describe, expect, test } from 'vitest';
import { LIMITS, PeerGuard, TokenBucket, messageSize } from '../../src/net/rateLimit';
import { NO_INPUT } from '../../src/sim/types';

describe('TokenBucket', () => {
  test('allows a burst, then refills at the rate', () => {
    const b = new TokenBucket(10, 5, 0);
    for (let i = 0; i < 5; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(100)).toBe(true); // 0.1 s → 1 token
    expect(b.take(100)).toBe(false);
    expect([...Array(20)].filter(() => b.take(10_000)).length).toBe(5); // never more than burst
  });
});

describe('messageSize', () => {
  test('measures a normal input well under the cap', () => {
    const n = messageSize({ t: 'input', input: NO_INPUT }, LIMITS.maxMsgBytes);
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(LIMITS.maxMsgBytes);
  });
  test('huge strings, wide objects and deep nesting are over the cap, with bounded work', () => {
    expect(messageSize({ t: 'chat', text: 'x'.repeat(100_000) }, 4096)).toBe(Infinity);
    const wide: Record<string, number> = {};
    for (let i = 0; i < 50_000; i++) wide[`k${i}`] = i;
    expect(messageSize({ t: 'input', input: wide }, 4096)).toBe(Infinity);
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = { a: deep };
    expect(messageSize(deep, 4096)).toBe(Infinity);
    expect(messageSize(new Array(1e6).fill(0), 4096)).toBe(Infinity);
  });
});

describe('PeerGuard', () => {
  const input = { t: 'input', input: NO_INPUT };
  test('a normal 30 Hz client is never throttled', () => {
    const g = new PeerGuard(0);
    for (let ms = 0; ms < 10_000; ms += 1000 / 30) {
      expect(g.admit(input, ms)).toBe('ok');
      expect(g.admitInput(ms)).toBe('ok');
    }
  });
  test('a backlog after a network stall is trimmed, not kicked', () => {
    const g = new PeerGuard(0);
    const verdicts = [...Array(300)].map(() => (g.admit(input, 10_000) === 'ok' ? g.admitInput(10_000) : 'drop'));
    expect(verdicts).not.toContain('kick');
    expect(verdicts.filter((v) => v === 'ok').length).toBeLessThanOrEqual(LIMITS.inputBurst);
  });
  test('a sustained flood is dropped and then kicked', () => {
    const g = new PeerGuard(0);
    let kicked = false, ok = 0;
    for (let i = 0; i < 2000 && !kicked; i++) {
      const v = g.admit(input, i); // 1000 msgs/s
      if (v === 'kick') kicked = true;
      else if (v === 'ok') ok++;
    }
    expect(kicked).toBe(true);
    expect(ok).toBeLessThan(400);
  });
  test('oversized messages are dropped and count heavily', () => {
    const g = new PeerGuard(0);
    expect(g.admit({ t: 'chat', text: 'x'.repeat(10_000) }, 0)).toBe('drop');
    let v = 'drop';
    for (let i = 0; i < 100 && v !== 'kick'; i++) v = g.admit({ t: 'chat', text: 'x'.repeat(10_000) }, i * 10);
    expect(v).toBe('kick');
  });
  test('malformed messages add strikes that decay', () => {
    const g = new PeerGuard(0);
    for (let i = 0; i < 100; i++) expect(g.malformed(0)).toBe('ok');
    // 10 s later they have decayed; another 100 is still fine
    for (let i = 0; i < 100; i++) expect(g.malformed(10_000)).toBe('ok');
    let v = 'ok';
    for (let i = 0; i < 1000 && v !== 'kick'; i++) v = g.malformed(10_000);
    expect(v).toBe('kick');
  });
});

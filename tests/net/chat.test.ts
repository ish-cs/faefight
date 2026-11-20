import { describe, expect, test } from 'vitest';
import { ChatLimiter, cleanChat } from '../../src/net/chat';
import { CHAT_MAX_LEN } from '../../src/net/protocol';

describe('cleanChat', () => {
  test('non-strings → null', () => {
    for (const v of [undefined, null, 42, {}, [], true, { toString: () => 'hi' }]) expect(cleanChat(v)).toBeNull();
  });

  test('empty / whitespace / control-only → null', () => {
    expect(cleanChat('')).toBeNull();
    expect(cleanChat('   \t ')).toBeNull();
    expect(cleanChat('\n\r\u0000\u0007\u007f')).toBeNull();
  });

  test('trims and collapses whitespace', () => {
    expect(cleanChat('  hello    world  ')).toBe('hello world');
  });

  test('control chars (incl. newlines) become separators, not glue', () => {
    expect(cleanChat('line1\nline2\r\nline3')).toBe('line1 line2 line3');
    expect(cleanChat('a\u0000b\u001bc\u007fd\u0085e')).toBe('a b c d e');
    expect(cleanChat('tab\there')).toBe('tab here');
  });

  test('markup is kept as literal text (rendering escapes it)', () => {
    expect(cleanChat('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  test('caps at CHAT_MAX_LEN, including a 10 KB input', () => {
    const big = 'x'.repeat(10 * 1024);
    const out = cleanChat(big)!;
    expect(out).toHaveLength(CHAT_MAX_LEN);
    expect(cleanChat('y'.repeat(CHAT_MAX_LEN))).toHaveLength(CHAT_MAX_LEN);
  });

  test('cap never splits a surrogate pair and re-trims', () => {
    const emoji = '\u{1F600}'; // 2 UTF-16 units
    const out = cleanChat(emoji.repeat(CHAT_MAX_LEN))!;
    expect(out.length).toBeLessThanOrEqual(CHAT_MAX_LEN);
    expect(out.endsWith('\uD83D')).toBe(false);
    expect(Array.from(out).every((c) => c === emoji)).toBe(true);
    const spaced = cleanChat('a'.repeat(CHAT_MAX_LEN - 1) + ' b')!;
    expect(spaced).toBe('a'.repeat(CHAT_MAX_LEN - 1));
  });

  test('unicode text passes through', () => {
    expect(cleanChat('héllo 世界 👋')).toBe('héllo 世界 👋');
  });
});

describe('ChatLimiter', () => {
  test('allows 2 per rolling second per sender', () => {
    const l = new ChatLimiter();
    expect(l.allow('a', 0)).toBe(true);
    expect(l.allow('a', 100)).toBe(true);
    expect(l.allow('a', 200)).toBe(false);
    expect(l.allow('a', 999)).toBe(false);
    expect(l.allow('a', 1000)).toBe(true); // first one (t=0) expired
    expect(l.allow('a', 1050)).toBe(false); // t=100 still in window
    expect(l.allow('a', 1100)).toBe(true);
  });

  test('senders are independent', () => {
    const l = new ChatLimiter();
    expect(l.allow('a', 0)).toBe(true);
    expect(l.allow('a', 0)).toBe(true);
    expect(l.allow('a', 0)).toBe(false);
    expect(l.allow('b', 0)).toBe(true);
    expect(l.allow('b', 0)).toBe(true);
    expect(l.allow('b', 0)).toBe(false);
  });

  test('rejected attempts do not extend the window', () => {
    const l = new ChatLimiter();
    l.allow('a', 0);
    l.allow('a', 0);
    for (let t = 1; t < 1000; t += 50) expect(l.allow('a', t)).toBe(false);
    expect(l.allow('a', 1000)).toBe(true);
  });
});

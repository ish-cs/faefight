import { describe, expect, test } from 'vitest';
import { Liveness } from '../../src/net/liveness';

describe('Liveness', () => {
  test('a silent peer is dead after deadMs of checks on time', () => {
    const l = new Liveness(0, 3000, 2500);
    for (let t = 1000; t <= 3000; t += 1000) expect(l.dead(t)).toBe(false);
    expect(l.dead(4000)).toBe(true);
  });

  test('hearing from the peer keeps it alive', () => {
    const l = new Liveness(0, 3000, 2500);
    for (let t = 1000; t <= 20_000; t += 1000) { l.heard(t - 500); expect(l.dead(t)).toBe(false); }
  });

  test('our own long frame is not the peer going silent: the timeout restarts after a stall', () => {
    const l = new Liveness(0, 3000, 2500);
    expect(l.dead(1000)).toBe(false);
    // Main thread blocked for 11 s (the check that was due at 2 s runs at 12 s).
    expect(l.dead(12_000)).toBe(false);
    // The peer's queued frames arrive right after.
    l.heard(12_001);
    expect(l.dead(13_000)).toBe(false);
  });

  test('a truly dead peer is still dropped deadMs after the stall ends', () => {
    const l = new Liveness(0, 3000, 2500);
    expect(l.dead(12_000)).toBe(false);
    expect(l.dead(13_000)).toBe(false);
    expect(l.dead(14_000)).toBe(false);
    expect(l.dead(15_000)).toBe(false);
    expect(l.dead(16_000)).toBe(true);
  });
});

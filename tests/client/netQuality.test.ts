import { describe, expect, test } from 'vitest';
import { LinkHealth, PingTracker, TickMonitor, pingLabel } from '../../src/client/qol/netQuality';

describe('PingTracker', () => {
  test('measures and smooths round trips; ignores stale or wrong pongs', () => {
    const p = new PingTracker();
    const n1 = p.ping('a', 1000);
    expect(p.pong('a', n1 + 99, 1050)).toBeNull();
    expect(p.pong('a', n1, 1040)).toBe(40);
    expect(p.pong('a', n1, 1041)).toBeNull(); // already answered
    const n2 = p.ping('a', 2000);
    expect(p.pong('a', n2, 2140)).toBeCloseTo(40 + 100 * 0.3);
    expect(p.get('a', 2200)).toBeCloseTo(70);
    expect(p.get('b', 2200)).toBeNull();
  });
  test('an unanswered ping shows up as a high RTT', () => {
    const p = new PingTracker();
    p.pong('a', p.ping('a', 0), 30);
    p.ping('a', 1000);
    expect(p.get('a', 1500)).toBe(30);
    expect(p.get('a', 4000)).toBe(3000);
  });
});

describe('TickMonitor', () => {
  test('30 Hz is ok; 20 Hz or a long stall is strained', () => {
    const m = new TickMonitor();
    for (let t = 0; t <= 3000; t += 33) m.onTick(t);
    expect(m.state(3000)).toBe('ok');
    const slow = new TickMonitor();
    for (let t = 0; t <= 3000; t += 50) slow.onTick(t);
    expect(slow.state(3000)).toBe('strained');
    const stall = new TickMonitor();
    for (let t = 0; t <= 1000; t += 33) stall.onTick(t);
    stall.onTick(1300);
    for (let t = 1333; t <= 2000; t += 33) stall.onTick(t);
    expect(stall.state(2000)).toBe('strained');
    expect(stall.state(3500)).toBe('strained'); // nothing at all lately
  });
});

describe('LinkHealth', () => {
  test('a delay spike flags the link for a few seconds', () => {
    const h = new LinkHealth();
    expect(h.bad(0, null)).toBe(false);
    for (let t = 0; t <= 1000; t += 67) h.onSnapshot(t);
    expect(h.bad(1000, 60)).toBe(false);
    expect(h.bad(1000, 400)).toBe(true); // high RTT
    expect(h.bad(1500, 60)).toBe(true); // stalled now
    h.onSnapshot(1500);
    for (let t = 1567; t <= 4400; t += 67) h.onSnapshot(t);
    expect(h.bad(4400, 60)).toBe(true); // spike 2.9 s ago
    for (let t = 4467; t <= 5000; t += 67) h.onSnapshot(t);
    expect(h.bad(5000, 60)).toBe(false);
  });
  test('labels', () => {
    expect(pingLabel(41.6, false)).toBe('42 ms');
    expect(pingLabel(null, false)).toBe('—');
    expect(pingLabel(5, true)).toBe('host');
  });
});

import { describe, expect, test } from 'vitest';
import { ClickGate, LOCK_GRACE_MS } from '../../src/client/clickGate';

describe('click gate: a re-capture click never acts', () => {
  test('a press while the pointer is unlocked produces no action', () => {
    const g = new ClickGate();
    expect(g.press(0, false, 1000)).toBe(false);
    expect(g.press(2, false, 1000)).toBe(false);
  });

  test('the re-capture press and its release never act; a second click right after the lock is swallowed too', () => {
    const g = new ClickGate();
    expect(g.press(0, false, 1000)).toBe(false);
    g.lockChange(true, 1010);
    expect(g.release(0)).toBe(true); // its release is ignored as well (no fire-stop, no aim release)
    expect(g.press(0, true, 1010 + 60)).toBe(false); // double-click's second click lands inside the grace
    expect(g.release(0)).toBe(true);
    expect(g.press(0, true, 1010 + LOCK_GRACE_MS)).toBe(true);
  });

  test('a lost release does not keep later presses swallowed', () => {
    const g = new ClickGate();
    expect(g.press(0, false, 0)).toBe(false);
    g.lockChange(true, 5);
    // No release seen (lost while the lock was being granted): the next press after the grace still acts.
    expect(g.press(0, true, 5 + LOCK_GRACE_MS + 1)).toBe(true);
  });

  test('a press inside the grace window after the lock comes back produces no action', () => {
    const g = new ClickGate();
    g.lockChange(true, 5000); // e.g. re-locked by the key that closed the shop
    expect(g.press(0, true, 5000 + LOCK_GRACE_MS - 1)).toBe(false);
    expect(g.release(0)).toBe(true);
  });

  test('a press after the lock plus a release acts normally', () => {
    const g = new ClickGate();
    expect(g.press(0, false, 0)).toBe(false);
    g.lockChange(true, 20);
    expect(g.release(0)).toBe(true);
    expect(g.press(0, true, 20 + LOCK_GRACE_MS)).toBe(true);
    expect(g.release(0)).toBe(false); // an acting press's release is a normal release
  });

  test('blur forgets held buttons', () => {
    const g = new ClickGate();
    g.press(0, false, 0);
    g.reset();
    expect(g.press(0, true, 10_000)).toBe(true);
  });
});

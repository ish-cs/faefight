import { describe, expect, it, test } from 'vitest';
import { InputAccumulator } from '../../src/client/inputAccum';
import { SnapshotBuffer } from '../../src/client/snapBuffer';
import { NO_INPUT } from '../../src/sim/types';

describe('InputAccumulator', () => {
  it('keeps a tap that happened between two takes, exactly once', () => {
    const a = new InputAccumulator();
    a.push({ ...NO_INPUT, reload: true, slot: 'pistol', moveZ: 1 });
    a.push({ ...NO_INPUT, moveZ: 1 });
    const t1 = a.take();
    expect(t1.reload).toBe(true);
    expect(t1.slot).toBe('pistol');
    expect(t1.moveZ).toBe(1);
    const t2 = a.take();
    expect(t2.reload).toBe(false);
    expect(t2.slot).toBeNull();
    expect(t2.moveZ).toBe(1); // held controls persist
  });

  it('hotbar select is held; drop and moveSlot are one-shots', () => {
    const a = new InputAccumulator();
    a.push({ ...NO_INPUT, select: 3, drop: 'one', moveSlot: { from: 0, to: 4 } });
    a.push({ ...NO_INPUT, select: 5 });
    expect(a.take()).toMatchObject({ select: 5, drop: 'one', moveSlot: { from: 0, to: 4 } });
    expect(a.take()).toMatchObject({ select: 5, drop: null, moveSlot: null });
    a.push({ ...NO_INPUT, drop: 'stack' });
    a.push({ ...NO_INPUT, drop: 'one' });
    expect(a.take().drop).toBe('stack');
  });

  it('useMedkit is a one-shot', () => {
    const a = new InputAccumulator();
    a.push({ ...NO_INPUT, useMedkit: true });
    a.push({ ...NO_INPUT });
    expect(a.take().useMedkit).toBe(true);
    expect(a.take().useMedkit).toBe(false);
  });

  it('drink is a one-shot', () => {
    const a = new InputAccumulator();
    a.push({ ...NO_INPUT, drink: true });
    a.push({ ...NO_INPUT });
    expect(a.take().drink).toBe(true);
    expect(a.take().drink).toBe(false);
  });

  it('takes held controls from the latest sample', () => {
    const a = new InputAccumulator();
    a.push({ ...NO_INPUT, yaw: 1, sprint: true });
    a.push({ ...NO_INPUT, yaw: 2 });
    expect(a.take()).toMatchObject({ yaw: 2, sprint: false });
  });
});

describe('SnapshotBuffer', () => {
  const s = (time: number) => ({ time });

  it('plays ~delay behind the newest snapshot with snapshot-spaced intervals', () => {
    const b = new SnapshotBuffer<{ time: number }>(0.1);
    b.push(s(1));
    expect(b.advance(0.016).map((r) => r.snap.time)).toEqual([1]);
    b.push(s(1 + 1 / 15));
    b.push(s(1 + 2 / 15));
    // play time started at 1 - delay; once it reaches 1 the next one releases with a 66 ms interval
    const out = [];
    for (let i = 0; i < 8; i++) out.push(...b.advance(0.016));
    expect(out.map((r) => r.snap.time)).toEqual([1 + 1 / 15]);
    expect(out[0].intervalMs).toBeCloseTo(1000 / 15, 3);
    expect(b.size).toBe(1);
  });

  it('drops stale and duplicate snapshots', () => {
    const b = new SnapshotBuffer<{ time: number }>(0.1);
    b.push(s(2));
    b.advance(0.01);
    b.push(s(2));
    b.push(s(1.5));
    expect(b.size).toBe(0);
  });

  it('never releases more than it has, and resyncs after a long stall', () => {
    const b = new SnapshotBuffer<{ time: number }>(0.1);
    for (let i = 0; i < 5; i++) b.push(s(i / 15));
    b.advance(0.01);
    for (let i = 5; i < 40; i++) b.push(s(i / 15)); // 2 s burst after a stall
    const out = b.advance(0.01);
    expect(out.length).toBeGreaterThan(0);
    expect(out.at(-1)!.snap.time).toBeLessThanOrEqual(39 / 15);
    expect(out.every((r) => r.intervalMs <= 250)).toBe(true);
  });
});

describe('InputAccumulator: lag compensation time', () => {
  test('a fire tap between sends keeps the view time it was fired at', () => {
    const acc = new InputAccumulator();
    acc.push({ ...NO_INPUT, fire: true, viewT: 3.25 });
    acc.push({ ...NO_INPUT });
    const got = acc.take();
    expect(got.fire).toBe(true);
    expect(got.viewT).toBe(3.25);
    expect(acc.take().viewT).toBeUndefined();
  });
});

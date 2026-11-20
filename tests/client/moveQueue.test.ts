import { describe, expect, test } from 'vitest';
import { MAX_CREDIT, MAX_QUEUE, MoveQueue } from '../../src/client/moveQueue';
import type { MoveCmd } from '../../src/sim/movement';

const cmd = (seq: number, c: Partial<MoveCmd> = {}): MoveCmd => ({ seq, moveX: 0, moveZ: 1, yaw: 0, jump: false, sprint: false, ...c });
const held = { moveX: 0, moveZ: 0, yaw: 0, sprint: false };
const seqs = (cs: MoveCmd[]) => cs.map((c) => c.seq);

describe('MoveQueue', () => {
  test('steady state: one command per tick', () => {
    const q = new MoveQueue();
    for (let i = 1; i <= 5; i++) { q.push([cmd(i)]); expect(seqs(q.take(held))).toEqual([i]); }
  });

  test('jitter: a late pair catches up on the next tick', () => {
    const q = new MoveQueue();
    q.push([cmd(1)]);
    expect(seqs(q.take(held))).toEqual([1]);
    expect(seqs(q.take(held))).toEqual([]); // starved one tick
    q.push([cmd(2), cmd(3)]);
    expect(seqs(q.take(held))).toEqual([2, 3]);
  });

  test('cannot run faster than real time', () => {
    const q = new MoveQueue();
    q.push([cmd(1)]); q.take(held);
    q.push(Array.from({ length: 8 }, (_, i) => cmd(i + 2)));
    expect(q.take(held)).toHaveLength(1);
    expect(q.take(held)).toHaveLength(1);
  });

  test('drops duplicates and stale commands', () => {
    const q = new MoveQueue();
    q.push([cmd(1), cmd(2)]);
    q.push([cmd(2), cmd(1)]);
    expect(q.size).toBe(2);
  });

  test('caps the queue, keeping the newest', () => {
    const q = new MoveQueue();
    q.push(Array.from({ length: MAX_QUEUE + 5 }, (_, i) => cmd(i + 1)));
    expect(q.size).toBe(MAX_QUEUE);
    expect(seqs(q.take(held))).toEqual([6]);
  });

  test('starved for a while → synthetic step from held input, seq not advanced, no jump', () => {
    const q = new MoveQueue();
    q.push([cmd(7, { jump: true })]);
    q.take(held);
    let out: MoveCmd[] = [];
    for (let i = 0; i < MAX_CREDIT; i++) out = q.take({ ...held, moveX: 1 });
    expect(out).toEqual([{ seq: 7, moveX: 1, moveZ: 0, yaw: 0, sprint: false, jump: false }]);
  });
});

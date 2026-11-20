/** Minimal snapshot shape the buffer needs (sim time in seconds). */
export type Timed = { time: number };

/**
 * Jitter buffer for snapshots received over the network (~15 Hz). Playback runs `delay` seconds
 * behind the newest snapshot; each released snapshot comes with the interval the renderer should
 * spend interpolating to it, so motion stays smooth despite irregular arrival.
 */
export class SnapshotBuffer<S extends Timed> {
  private q: S[] = [];
  private playTime: number | null = null;
  private lastReleased: number | null = null;

  constructor(private delay = 0.1, private maxDrift = 0.25) {}

  push(s: S) {
    const newest = this.q.length ? this.q[this.q.length - 1].time : this.lastReleased;
    if (newest !== null && s.time <= newest) return; // stale / duplicate
    this.q.push(s);
  }

  get size() {
    return this.q.length;
  }

  /** Advance playback by dt seconds; returns snapshots to feed the renderer, in order. */
  advance(dt: number): { snap: S; intervalMs: number }[] {
    if (!this.q.length) {
      if (this.playTime !== null) this.playTime += dt;
      return [];
    }
    const target = this.q[this.q.length - 1].time - this.delay;
    if (this.playTime === null || Math.abs(target - this.playTime) > this.maxDrift) this.playTime = target;
    else this.playTime += dt + (target - this.playTime) * 0.05; // slowly converge on the target delay
    const out: { snap: S; intervalMs: number }[] = [];
    // Release the next snapshot once the previous one has been fully reached.
    while (this.q.length && (this.lastReleased === null || this.playTime >= this.lastReleased)) {
      const s = this.q.shift()!;
      const intervalMs = this.lastReleased === null ? 0 : Math.min(250, (s.time - this.lastReleased) * 1000);
      this.lastReleased = s.time;
      out.push({ snap: s, intervalMs });
    }
    return out;
  }
}

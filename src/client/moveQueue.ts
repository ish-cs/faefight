import type { MoveCmd } from '../sim/movement';

/** Ticks of credit a player may bank: absorbs ~200 ms of input jitter/bursts. */
export const MAX_CREDIT = 6;
/** Queue cap; older commands beyond this are dropped (the client reconciles). */
export const MAX_QUEUE = 10;

/**
 * Host-side queue of one player's numbered movement commands (one per 1/30 s client step).
 * Each sim tick earns one credit and spends one per command, so bursts from jitter catch up but a
 * client can never move faster than real time. A player whose commands stop arriving (stalled
 * link, hidden tab) gets a synthetic step from their held input once credit maxes out, so they
 * can't hang in the air.
 */
export class MoveQueue {
  private q: MoveCmd[] = [];
  private credit = 0;
  private lastSeq = 0;
  private lastTaken = 0;

  push(cmds: readonly MoveCmd[]) {
    for (const c of cmds) {
      if (c.seq <= this.lastSeq) continue; // duplicate / out of order
      this.lastSeq = c.seq;
      this.q.push(c);
    }
    if (this.q.length > MAX_QUEUE) this.q.splice(0, this.q.length - MAX_QUEUE);
  }

  get size() { return this.q.length; }

  /** Commands to simulate this tick, in order. `held` = the player's latest held input. */
  take(held: Pick<MoveCmd, 'moveX' | 'moveZ' | 'yaw' | 'sprint'>): MoveCmd[] {
    this.credit = Math.min(MAX_CREDIT, this.credit + 1);
    const out: MoveCmd[] = [];
    while (this.credit >= 1 && this.q.length) {
      const c = this.q.shift()!;
      this.lastTaken = c.seq;
      out.push(c);
      this.credit--;
    }
    if (!out.length && this.credit >= MAX_CREDIT) {
      out.push({ seq: this.lastTaken, moveX: held.moveX, moveZ: held.moveZ, yaw: held.yaw, sprint: held.sprint, jump: false });
      this.credit--;
    }
    return out;
  }
}

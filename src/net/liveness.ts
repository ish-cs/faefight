/**
 * Link liveness that tolerates our own slow frames.
 *
 * Each side checks "have I heard from the far side within deadMs?" from a setInterval on the main thread.
 * If that thread stalls (a long frame: shader compiles at match start, a loaded machine), the check runs
 * late, and the frames the far side kept sending are still queued behind it: the silence was ours, not
 * theirs. So a check that comes much later than its interval counts as a stall, and the far side gets a
 * fresh deadMs of our awake time before it is declared dead. A truly dead peer is still dropped deadMs
 * after the stall ends.
 */
export class Liveness {
  private lastSeen: number;
  private lastCheck: number;

  /** `stallMs`: a gap between two checks longer than this means our own thread was stalled. */
  constructor(now: number, private readonly deadMs: number, private readonly stallMs: number) {
    this.lastSeen = now;
    this.lastCheck = now;
  }

  /** Something arrived from the far side. */
  heard(now: number): void {
    this.lastSeen = now;
  }

  /** Called every interval: true when the far side has been silent for deadMs while we were awake. */
  dead(now: number): boolean {
    if (now - this.lastCheck > this.stallMs) {
      console.info(`[net] own thread stalled ${Math.round(now - this.lastCheck)} ms: link timeout restarted`);
      this.lastSeen = Math.max(this.lastSeen, now);
    }
    this.lastCheck = now;
    return now - this.lastSeen > this.deadMs;
  }
}

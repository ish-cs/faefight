/** After the pointer lock comes back, presses are ignored for this long (the re-capture click's bounce). */
export const LOCK_GRACE_MS = 150;

/**
 * Decides whether a mouse press may act in the game. A press while the pointer is not locked only
 * re-captures it: neither it nor its release acts, and any press within LOCK_GRACE_MS of the lock
 * coming back (a double-click's second click, a bounce) is swallowed too. Every click action (fire, melee, build,
 * throw, place, use) goes through InputController.onMouseDown, which asks this gate first.
 */
export class ClickGate {
  private swallowed = new Set<number>();
  private lockedAt = -Infinity;

  /** Pointer lock gained (true) or lost (false). */
  lockChange(locked: boolean, now: number) {
    if (locked) this.lockedAt = now;
  }

  /**
   * A button went down: true = it may act; false = swallow it (it only re-captures the pointer). A new
   * press of a button proves its earlier press ended, even if that release never reached us (it can be
   * lost while the lock is being granted), so only the lock state and the grace decide.
   */
  press(button: number, locked: boolean, now: number): boolean {
    this.swallowed.delete(button);
    if (!locked || now - this.lockedAt < LOCK_GRACE_MS) {
      this.swallowed.add(button);
      return false;
    }
    return true;
  }

  /** A button went up: true = its press had been swallowed (so its release must be ignored as well). */
  release(button: number): boolean {
    return this.swallowed.delete(button);
  }

  /** Window lost focus: no button is held any more. */
  reset() {
    this.swallowed.clear();
  }
}

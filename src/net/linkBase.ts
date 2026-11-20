import type { Link } from './transport';

/**
 * Shared Link plumbing for every transport:
 * - messages that arrive before the first onMessage() are buffered (not lost);
 * - onClose fires exactly once, only when the link ends from the far side or the wire
 *   (a local close() does not call your own onClose); registering after the end still fires;
 * - send() after the end is a silent no-op.
 * Subclasses implement `transmit` and `teardown`, and call `deliver` / `ended` on wire events.
 */
export abstract class LinkBase implements Link {
  private msgCbs: Array<(msg: unknown) => void> = [];
  private closeCbs: Array<() => void> = [];
  private pending: unknown[] = [];
  private done = false;
  private endedRemotely = false;

  constructor(readonly peerId: string) {}

  protected abstract transmit(msg: unknown): void;
  /** Release wire resources and tell the far side, if possible. Called once. */
  protected abstract teardown(): void;

  get isClosed(): boolean {
    return this.done;
  }

  send(msg: unknown): void {
    if (this.done) return;
    this.transmit(msg);
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.msgCbs.push(cb);
    if (this.msgCbs.length === 1 && this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const m of queued) this.dispatch(m);
    }
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
    if (this.endedRemotely) queueMicrotask(cb);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.pending = [];
    this.teardown();
  }

  /** Subclass: a message arrived from the far side. */
  protected deliver(msg: unknown): void {
    if (this.done) return;
    if (this.msgCbs.length === 0) this.pending.push(msg);
    else this.dispatch(msg);
  }

  /** Subclass: the far side closed or the wire died. */
  protected ended(): void {
    if (this.done) return;
    this.done = true;
    this.endedRemotely = true;
    // Keep `pending`: a final message (e.g. {t:'ended', reason}) sent just before the close
    // must still reach a handler registered late.
    this.teardown();
    for (const cb of this.closeCbs) cb();
  }

  private dispatch(msg: unknown): void {
    for (const cb of this.msgCbs) {
      try {
        cb(msg);
      } catch (err) {
        console.error('[net] onMessage handler threw', err);
      }
    }
  }
}

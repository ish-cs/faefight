/**
 * End-of-match flow helpers: who gets which end-screen buttons, and a scope that lets a running game be
 * torn down completely (DOM, window/document listeners) so a rematch starts from a clean slate.
 */

/** solo = vs bot (Play again); host = online host (Rematch / Back to lobby); client = online joiner (waits). */
export type EndRole =
  | { kind: 'solo'; playAgain(): void }
  | { kind: 'host'; rematch(): void; toLobby(): void }
  | { kind: 'client' };

const button = (text: string, testid: string, onClick: () => void, primary = false) => {
  const b = document.createElement('button');
  b.className = `btn${primary ? ' primary' : ''}`;
  b.textContent = text;
  b.dataset.testid = testid;
  b.onclick = onClick;
  return b;
};

/** End-screen buttons. over = the match has a result; otherwise you were eliminated and it goes on. */
export function endButtons(role: EndRole, over: boolean, act: { spectate(): void; backToMenu(): void }): HTMLElement[] {
  const spectate = button('Spectate', 'spectate', act.spectate, !over);
  const menu = button(role.kind === 'client' ? 'Leave' : 'Back to menu', 'back-to-menu', act.backToMenu);
  if (!over) return [spectate, menu];
  const once = (f: () => void) => (e: MouseEvent) => {
    (e.currentTarget as HTMLElement).parentElement?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    f();
  };
  if (role.kind === 'solo') {
    const again = button('Play again', 'play-again', () => {}, true);
    again.onclick = once(role.playAgain);
    return [again, spectate, menu];
  }
  if (role.kind === 'host') {
    const re = button('Rematch', 'rematch', () => {}, true);
    re.onclick = once(role.rematch);
    const lobby = button('Back to lobby', 'back-to-lobby', () => {});
    lobby.onclick = once(role.toLobby);
    return [re, lobby, spectate, menu];
  }
  const wait = document.createElement('div');
  wait.className = 'end-wait';
  wait.dataset.testid = 'waiting-host';
  wait.textContent = 'Waiting for host…';
  return [wait, spectate, menu];
}

/**
 * Everything a game adds to the page, so it can be removed again: elements appended to `roots` after
 * construction, and window/document listeners registered between begin() and end() (an AbortSignal is added).
 * Listeners on the game's own elements go away with the elements.
 */
export class GameScope {
  private before: Set<Element>;
  private ac = new AbortController();

  constructor(private roots: HTMLElement[]) {
    this.before = new Set(roots.flatMap((r) => [...r.children]));
  }

  private restore: (() => void) | null = null;

  /**
   * Start tagging window/document listeners with this scope's signal. Ends at end(), or at the latest when
   * the current synchronous run finishes (a microtask), so an exception can't leave the patch in place.
   */
  begin() {
    if (this.restore) return;
    const proto = EventTarget.prototype;
    const orig = proto.addEventListener;
    const signal = this.ac.signal;
    proto.addEventListener = function (this: EventTarget, type: string, cb: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
      if (this === window || this === document) opts = typeof opts === 'boolean' ? { capture: opts, signal } : { ...opts, signal };
      return orig.call(this, type, cb, opts);
    };
    this.restore = () => { proto.addEventListener = orig; };
    queueMicrotask(() => this.end());
  }

  end() {
    this.restore?.();
    this.restore = null;
  }

  dispose() {
    this.ac.abort();
    for (const r of this.roots) for (const c of [...r.children]) if (!this.before.has(c)) c.remove();
  }
}

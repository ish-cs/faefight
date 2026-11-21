import { CHAT_MAX_LEN } from '../net/protocol';
import { isAction } from './keymap';
import { isMuted } from './chatMute';

const MAX_LINES = 6;
const FADE_MS = 8000;

export type ChatHooks = {
  /** User submitted a non-empty line. */
  send(text: string): void;
  /** Input opened (true) or closed (false): the game disables/re-enables its controls. */
  typing(open: boolean): void;
};

/** Bottom-left chat feed + one-line input. All text is rendered with textContent only. */
export class ChatUi {
  readonly root = document.createElement('div');
  private feed = document.createElement('div');
  private input = document.createElement('input');
  private lines: { at: number; node: HTMLElement }[] = [];
  /** When false (menus, panels, end screen) Enter does not open the input. */
  enabled = true;

  constructor(parent: HTMLElement, private hooks: ChatHooks) {
    this.root.className = 'chat';
    this.feed.className = 'chat-feed';
    this.feed.dataset.testid = 'chat-feed';
    this.input.className = 'chat-input glass';
    this.input.dataset.testid = 'chat-input';
    this.input.maxLength = CHAT_MAX_LEN;
    this.input.placeholder = 'Say something…  (Enter send · Esc cancel)';
    this.input.style.display = 'none';
    this.root.append(this.feed, this.input);
    parent.append(this.root);

    // Capture phase: runs before the game's key handlers so Enter/Esc/letters never reach them while typing.
    window.addEventListener('keydown', (e) => {
      if (this.open) {
        e.stopPropagation();
        if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this.submit(); }
        else if (e.code === 'Escape') { e.preventDefault(); this.close(); }
        return;
      }
      if (isAction('chat', e.code) && this.enabled && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        e.stopPropagation();
        this.openInput();
      }
    }, { capture: true });
    // Key-ups are left alone so keys held when the input opened are released in the game.
    setInterval(() => this.fade(), 500);
  }

  get open() {
    return this.input.style.display !== 'none';
  }

  private openInput() {
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.style.display = '';
    this.input.value = '';
    this.root.classList.add('typing');
    this.hooks.typing(true);
    this.input.focus();
  }

  close() {
    if (!this.open) return;
    this.input.style.display = 'none';
    this.input.blur();
    this.root.classList.remove('typing');
    this.hooks.typing(false);
  }

  private submit() {
    const text = this.input.value.trim();
    this.close();
    if (text) this.hooks.send(text);
  }

  /** Append a line. from = '' → system line. */
  add(from: string, text: string) {
    if (isMuted(from)) return;
    const line = document.createElement('div');
    line.className = from ? 'chat-line' : 'chat-line system';
    if (from) {
      const who = document.createElement('span');
      who.className = 'chat-from';
      who.textContent = `${from}: `;
      line.append(who);
    }
    const body = document.createElement('span');
    body.textContent = text;
    line.append(body);
    this.feed.append(line);
    this.lines.push({ at: performance.now(), node: line });
    while (this.lines.length > MAX_LINES) this.lines.shift()!.node.remove();
  }

  private fade() {
    const now = performance.now();
    for (const l of this.lines) l.node.classList.toggle('old', now - l.at > FADE_MS);
  }
}

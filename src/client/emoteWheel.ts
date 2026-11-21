import { DEFAULT_WHEEL, isEmoteId, WHEEL_COOLDOWN_SEC, wheelLabel, wheelSlot, type EmoteId, type WheelId } from '../sim/emotes';

/**
 * Emote & quick-chat wheel: hold the key, push the mouse toward a slot, release to send (Esc cancels).
 * A radial glass panel at the screen centre in the HUD style. The mouse drives a virtual cursor: raw
 * movement while the pointer is locked, the real cursor position otherwise. Slot math: sim/emotes.ts.
 */

const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"';

/** Emote icons (24×24, currentColor), matching the hotbar/shop line icons. */
export const EMOTE_ICONS: Record<EmoteId, string> = {
  wave: svg(`<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V5.5a1.5 1.5 0 0 1 3 0V13c0 4-2.5 7-6 7-2.6 0-4-1.4-5.3-3.6L3.9 13.3a1.4 1.4 0 0 1 2.3-1.5L8 14" ${S}/><path d="M19.5 3.5c1 .8 1.6 1.9 1.7 3.2M2.5 7c.2-1.3.8-2.4 1.8-3.2" ${S}/>`),
  dance: svg(`<circle cx="12" cy="4" r="2" fill="currentColor"/><path d="M12 7.5 10.5 13l2.5 3-1 5M10.5 13 7 15.5M12 8l5-3.5M11.3 9.5 6 7.5M13 16l4 2" ${S}/><path d="M19 10.5v-3l2.5-.6v2.8" ${S} stroke-width="1.4"/><circle cx="18.3" cy="10.6" r=".9" fill="currentColor"/><circle cx="20.8" cy="9.8" r=".9" fill="currentColor"/>`),
  salute: svg(`<circle cx="11" cy="6" r="2.6" ${S}/><path d="M6.5 21v-5.5A4.5 4.5 0 0 1 11 11h0a4.5 4.5 0 0 1 4.5 4.5V21" ${S}/><path d="M15 12.5l3.5-5.2-3.6-2.1" ${S}/><path d="M8.2 4.6h5.6" ${S} stroke-width="1.4"/>`),
  laugh: svg(`<circle cx="12" cy="12" r="9" ${S}/><path d="M7.5 9.5l2 1-2 1M16.5 9.5l-2 1 2 1" ${S} stroke-width="1.5"/><path d="M7.5 14h9a4.5 4.5 0 0 1-9 0z" fill="currentColor"/>`),
  point: svg(`<path d="M3 11.5h11a1.5 1.5 0 0 1 0 3H11M11 14.5h1.5a1.5 1.5 0 0 1 0 3H11M11 17.5h.5a1.4 1.4 0 0 1 0 2.8H7.5C5 20.3 3.5 18.5 3.5 16v-4.5M11 14.5l-.5-3" ${S}/><path d="M14 13h7M18.5 10.5 21 13l-2.5 2.5" ${S}/>`),
};
const QUIP_ICON = svg(`<path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 20 17h-8.5L7 20.5V17H4a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 4 5.5z" ${S}/>`);

/** Cursor travel cap (px): the virtual cursor stays on the ring, so changing your mind is a short move. */
const MAX_R = 120;

export class EmoteWheel {
  readonly root: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private hub: HTMLElement;
  private dx = 0;
  private dy = 0;
  private hover = -1;
  private openFlag = false;
  private lastSentAt = -Infinity;

  constructor(parent: HTMLElement, private readonly slots: readonly WheelId[] = DEFAULT_WHEEL) {
    if (slots.length < 2) throw new Error(`EmoteWheel: need at least 2 slots, got ${slots.length}`);
    this.root = document.createElement('div');
    this.root.className = 'emote-wheel';
    this.root.dataset.testid = 'emote-wheel';
    this.root.hidden = true;
    const ring = document.createElement('div');
    ring.className = 'ew-ring';
    this.root.append(ring);
    slots.forEach((id, i) => {
      const a = (i / slots.length) * Math.PI * 2; // 0 = up, clockwise
      const el = document.createElement('div');
      el.className = `ew-slot ${isEmoteId(id) ? 'emote' : 'quip'}`;
      el.dataset.id = id;
      el.style.setProperty('--x', `${Math.sin(a) * 104}px`);
      el.style.setProperty('--y', `${-Math.cos(a) * 104}px`);
      el.innerHTML = `<span class="ew-icon">${isEmoteId(id) ? EMOTE_ICONS[id] : QUIP_ICON}</span><span class="ew-label"></span>`;
      (el.querySelector('.ew-label') as HTMLElement).textContent = wheelLabel(id);
      this.root.append(el);
      this.slotEls.push(el);
    });
    this.hub = document.createElement('div');
    this.hub.className = 'ew-hub';
    this.root.append(this.hub);
    parent.append(this.root);
  }

  get open() { return this.openFlag; }
  /** Slot under the cursor (-1 = centre / none). */
  get hovered() { return this.hover; }

  show() {
    this.openFlag = true;
    this.dx = this.dy = 0;
    this.root.hidden = false;
    this.refresh();
  }

  /** Pointer locked: raw mouse movement moves the virtual cursor. */
  move(mx: number, my: number) {
    if (!this.openFlag) return;
    this.dx += mx; this.dy += my;
    const r = Math.hypot(this.dx, this.dy);
    if (r > MAX_R) { this.dx *= MAX_R / r; this.dy *= MAX_R / r; }
    this.refresh();
  }

  /** Pointer free: the real cursor, relative to the screen centre. */
  pointAt(clientX: number, clientY: number) {
    if (!this.openFlag) return;
    this.dx = clientX - innerWidth / 2;
    this.dy = clientY - innerHeight / 2;
    this.refresh();
  }

  /** Close; the picked id, or null (released in the centre, or still cooling down). */
  release(nowMs = performance.now()): WheelId | null {
    if (!this.openFlag) return null;
    const id = this.hover >= 0 ? this.slots[this.hover] : null;
    const ready = this.cooldownLeft(nowMs) === 0;
    this.close();
    if (!id || !ready) return null;
    this.lastSentAt = nowMs;
    return id;
  }

  cancel() { if (this.openFlag) this.close(); }

  /** Seconds until the next pick is accepted (the host enforces the same limit). */
  cooldownLeft(nowMs = performance.now()) {
    return Math.max(0, WHEEL_COOLDOWN_SEC - (nowMs - this.lastSentAt) / 1000);
  }

  private close() {
    this.openFlag = false;
    this.root.hidden = true;
    this.hover = -1;
  }

  private refresh() {
    this.hover = wheelSlot(this.dx, this.dy, this.slots.length);
    this.slotEls.forEach((el, i) => el.classList.toggle('active', i === this.hover));
    const wait = this.cooldownLeft();
    this.root.classList.toggle('cooling', wait > 0);
    this.hub.textContent = wait > 0 ? `Wait ${wait.toFixed(1)}s` : this.hover >= 0 ? wheelLabel(this.slots[this.hover]) : 'Release to send · Esc cancels';
  }
}

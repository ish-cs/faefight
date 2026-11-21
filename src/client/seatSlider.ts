import type { Slot } from '../net/protocol';
import type { Difficulty } from '../sim/types';

/**
 * Lobby seat control: a 5-stop slider Open · Easy · Medium · Hard · PRO (replaces a <select>).
 * Click a stop, drag the thumb, or use the arrow keys / Home / End. The pure helpers below are what
 * the unit tests cover; seatSlider() builds the DOM.
 */

export type SeatValue = 'open' | Difficulty;
export const SEAT_STOPS: readonly SeatValue[] = ['open', 'easy', 'medium', 'hard', 'pro'];
export const SEAT_LABEL: Record<SeatValue, string> = { open: 'Open', easy: 'Easy', medium: 'Medium', hard: 'Hard', pro: 'PRO' };
const LAST = SEAT_STOPS.length - 1;

/** Stop index for an open/bot seat (a human seat has no slider: -1). */
export function slotToStop(slot: Slot): number {
  if (slot.kind === 'open') return 0;
  if (slot.kind === 'bot') return SEAT_STOPS.indexOf(slot.difficulty);
  return -1;
}

/** Seat the host asked for at stop i (clamped). */
export function stopToSlot(i: number): Slot {
  const v = SEAT_STOPS[Math.max(0, Math.min(LAST, Math.round(i)))];
  return v === 'open' ? { kind: 'open' } : { kind: 'bot', difficulty: v };
}

/** Stop after a key press, or null if the key isn't a slider key. */
export function keyStop(stop: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft': case 'ArrowDown': return Math.max(0, stop - 1);
    case 'ArrowRight': case 'ArrowUp': return Math.min(LAST, stop + 1);
    case 'Home': return 0;
    case 'End': return LAST;
    default: return null;
  }
}

/** Continuous thumb position (0..LAST, stop centres at integers) for a pointer x inside a track of this width. */
export function posFromX(x: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(0, Math.min(LAST, (x / width) * SEAT_STOPS.length - 0.5));
}

/**
 * The slider element. `from` (optional) is where the thumb starts so a re-rendered lobby slides it
 * from the previous stop. onPick fires once per committed change (release / click / key).
 */
export function seatSlider(stop: number, onPick: (stop: number) => void, from = stop): HTMLElement {
  const root = document.createElement('div');
  root.className = 'seat-slider';
  root.tabIndex = 0;
  root.setAttribute('role', 'slider');
  root.setAttribute('aria-label', 'Seat: open or bot difficulty');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', String(LAST));
  const fill = document.createElement('div');
  fill.className = 'fill';
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  root.append(fill, thumb);
  const labels = SEAT_STOPS.map((v) => {
    const s = document.createElement('span');
    s.className = `stop stop-${v}`;
    s.textContent = SEAT_LABEL[v];
    root.append(s);
    return s;
  });

  let current = stop;
  /** Paint the thumb at a (possibly fractional, while dragging) position. */
  const paint = (pos: number) => {
    const near = Math.round(pos);
    root.style.setProperty('--pos', pos.toFixed(3));
    root.dataset.tone = SEAT_STOPS[near];
    labels.forEach((l, i) => l.classList.toggle('on', i === near));
  };
  const settle = (i: number) => {
    current = i;
    root.dataset.value = SEAT_STOPS[i];
    root.setAttribute('aria-valuenow', String(i));
    root.setAttribute('aria-valuetext', SEAT_LABEL[SEAT_STOPS[i]]);
    paint(i);
  };
  const pick = (i: number) => {
    if (i === current) { paint(i); return; }
    settle(i);
    onPick(i);
  };

  settle(stop);
  if (from !== stop && from >= 0) {
    paint(from);
    requestAnimationFrame(() => requestAnimationFrame(() => paint(current)));
  }

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.focus();
    root.setPointerCapture(e.pointerId);
    root.classList.add('dragging');
    const at = (ev: PointerEvent) => posFromX(ev.clientX - root.getBoundingClientRect().left, root.clientWidth);
    paint(at(e));
    const move = (ev: PointerEvent) => paint(at(ev));
    const up = (ev: PointerEvent) => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
      root.removeEventListener('pointercancel', up);
      root.classList.remove('dragging');
      if (ev.type === 'pointercancel') paint(current); else pick(Math.round(at(ev)));
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
  });
  root.addEventListener('keydown', (e) => {
    const next = keyStop(current, e.key);
    if (next === null) return;
    e.preventDefault();
    pick(next);
  });
  return root;
}

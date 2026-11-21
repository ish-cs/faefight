import type { Difficulty } from '../../sim/types';
import { joinCodeFrom } from './invite';
import { loadPrefs, MAX_SOLO_BOTS, savePrefs } from './prefs';
import { loadRejoin, takeAutoRejoin, type RejoinRecord } from './rejoin';
import './qol.css';

/**
 * Main-menu QoL: remembers the vs-bot difficulty and bot count (segmented control, no dropdown), and
 * handles `?join=CODE` links and the reconnect offer.
 */

/** Highlight the last-played difficulty and remember a new pick. Buttons carry data-testid="play-<difficulty>". */
export function rememberDifficulty(play: HTMLElement) {
  const last = loadPrefs().difficulty;
  for (const b of play.querySelectorAll<HTMLButtonElement>('button[data-testid^="play-"]')) {
    const d = b.dataset.testid!.slice(5) as Difficulty;
    b.classList.toggle('primary', d === last);
    b.addEventListener('click', () => savePrefs({ difficulty: d }), { capture: true });
  }
}

/** "Bots 1 2 3 … 7" segmented control; returns a getter for the current count. */
export function botCountControl(): { root: HTMLElement; count(): number } {
  let n = loadPrefs().bots;
  const root = document.createElement('div');
  root.className = 'qol-seg';
  root.dataset.testid = 'bot-count';
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', 'Number of bots');
  const buttons = Array.from({ length: MAX_SOLO_BOTS }, (_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(i + 1);
    b.dataset.testid = `bots-${i + 1}`;
    b.setAttribute('role', 'radio');
    b.onclick = () => { n = i + 1; savePrefs({ bots: n }); sync(); };
    return b;
  });
  const sync = () => buttons.forEach((b, i) => { b.classList.toggle('on', i + 1 === n); b.setAttribute('aria-checked', String(i + 1 === n)); });
  sync();
  seg.append(...buttons);
  const label = document.createElement('span');
  label.textContent = 'Bots';
  root.append(label, seg);
  return { root, count: () => n };
}

export type JoinUi = { online: HTMLElement; nameIn: HTMLInputElement; codeIn: HTMLInputElement; joinBtn: HTMLButtonElement; status: HTMLElement };

/**
 * Fill the join form from `?join=CODE` (focus the name; with a remembered name it's one click) or from a
 * fresh rejoin record (offer to rejoin; auto-join after a dropped link). Returns the rejoin record in play.
 */
export function prepareJoin(ui: JoinUi): RejoinRecord | null {
  const rejoin = loadRejoin();
  const auto = takeAutoRejoin();
  const code = rejoin?.code ?? joinCodeFrom(location.search);
  if (!code) return null;
  ui.codeIn.value = code;
  ui.online.classList.add('qol-invited');
  if (rejoin) {
    if (!ui.nameIn.value) ui.nameIn.value = rejoin.name;
    const note = document.createElement('div');
    note.className = 'qol-rejoin';
    note.dataset.testid = 'rejoin-offer';
    note.textContent = `Your match ${rejoin.code} is still on: Join game to take your seat back.`;
    ui.online.append(note);
    if (auto) { ui.status.textContent = `Reconnecting to ${rejoin.code}…`; queueMicrotask(() => ui.joinBtn.click()); return rejoin; }
    ui.joinBtn.classList.add('primary');
    ui.joinBtn.focus();
    return rejoin;
  }
  ui.joinBtn.classList.add('primary');
  ui.nameIn.focus();
  if (ui.nameIn.value) ui.nameIn.select();
  return null;
}

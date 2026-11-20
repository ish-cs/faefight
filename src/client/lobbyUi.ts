import type { Slot } from '../net/protocol';
import { MAX_PLAYERS } from '../net/protocol';
import type { Difficulty } from '../sim/types';
import { ISLAND_COLORS, ISLAND_NAMES } from './render';

export type LobbyActions = {
  setSeat(i: number, slot: Slot): void;
  addSeat(): void;
  removeSeat(i: number): void;
  kick(i: number): void;
  start(): void;
  back(): void;
};

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const DIFFS: Difficulty[] = ['easy', 'medium', 'hard', 'pro'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** Seat-select label: "Easy", "Medium", "Hard", "PRO". */
const diffLabel = (d: Difficulty) => (d === 'pro' ? 'PRO' : cap(d));
/** Lobby tag: "easy", "medium", "hard", "PRO". */
const diffTag = (d: Difficulty) => (d === 'pro' ? 'PRO' : d);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * Lobby screen. Host (actions given) can edit non-host seats; joiners (actions = null) see a read-only list.
 * Names come from the network: always rendered with textContent.
 */
export class LobbyUi {
  readonly root = el('div', 'menu lobby');
  private card = el('div', 'menu-card glass lobby-card');
  private list = el('div', 'seats');
  private footer = el('div', 'lobby-footer');
  private status = el('div', 'lobby-status');
  private startBtn: HTMLButtonElement | null = null;

  constructor(parent: HTMLElement, code: string, private actions: LobbyActions | null, back: () => void) {
    const title = el('div', 'label', 'Invite code');
    const codeRow = el('div', 'code-row');
    const codeEl = el('div', 'invite-code', code);
    codeEl.dataset.testid = 'lobby-code';
    const copy = el('button', 'btn small', 'Copy');
    copy.onclick = () => {
      navigator.clipboard?.writeText(code).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; });
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    };
    codeRow.append(codeEl, copy);
    const hint = el('div', 'lobby-hint', actions ? 'Share the code. Friends pick Join game and type it in.' : 'Joined. The host picks the seats and starts the match.');
    const backBtn = el('button', 'btn small', actions ? 'Close lobby' : 'Leave');
    backBtn.onclick = back;
    backBtn.dataset.testid = 'lobby-back';
    if (actions) {
      const add = el('button', 'btn small', '+ Add seat');
      add.dataset.testid = 'add-seat';
      add.onclick = () => actions.addSeat();
      this.startBtn = el('button', 'btn primary', 'Start match');
      this.startBtn.dataset.testid = 'start-match';
      this.startBtn.onclick = () => { this.startBtn!.disabled = true; actions.start(); };
      this.footer.append(backBtn, add, this.startBtn);
    } else {
      this.status.textContent = 'Waiting for host…';
      this.footer.append(backBtn);
    }
    this.card.append(el('h1', '', 'Lobby'), title, codeRow, hint, this.list, this.status, this.footer);
    this.root.append(this.card);
    parent.append(this.root);
  }

  render(slots: Slot[], you: number) {
    const a = this.actions;
    this.list.replaceChildren(...slots.map((s, i) => {
      const row = el('div', 'seat');
      row.dataset.testid = `seat-${i}`;
      const dot = el('span', 'dot');
      dot.style.background = hex(ISLAND_COLORS[i % 8]);
      dot.title = ISLAND_NAMES[i % 8];
      const name = el('span', 'seat-name');
      if (s.kind === 'human') {
        name.textContent = s.name;
        if (s.isHost) name.append(el('span', 'tagpill', 'host'));
        if (i === you) name.append(el('span', 'tagpill you', 'you'));
      } else if (s.kind === 'bot') {
        name.textContent = s.name ?? 'Bot';
        name.append(el('span', 'tagpill', `bot · ${diffTag(s.difficulty)}`));
      }
      else { name.textContent = 'Open'; name.classList.add('open'); }
      row.append(dot, name);
      if (a && i > 0 && s.kind !== 'human') {
        const sel = el('select', 'seat-select');
        sel.dataset.testid = `seat-select-${i}`;
        for (const [v, label] of [['open', 'Open'], ...DIFFS.map((d) => [`bot-${d}`, `Bot ${diffLabel(d)}`])]) {
          const o = el('option', '', label);
          o.value = v;
          sel.append(o);
        }
        sel.value = s.kind === 'bot' ? `bot-${s.difficulty}` : 'open';
        sel.onchange = () => a.setSeat(i, sel.value === 'open' ? { kind: 'open' } : { kind: 'bot', difficulty: sel.value.slice(4) as Difficulty });
        const rm = el('button', 'btn small icon', '✕');
        rm.title = 'Remove seat';
        rm.dataset.testid = `remove-seat-${i}`;
        rm.disabled = slots.length <= 2;
        rm.onclick = () => a.removeSeat(i);
        row.append(sel, rm);
      }
      if (a && i > 0 && s.kind === 'human') {
        const kick = el('button', 'btn small', 'Kick');
        kick.dataset.testid = `kick-${i}`;
        kick.onclick = () => a.kick(i);
        row.append(kick);
      }
      return row;
    }));
    const add = this.footer.querySelector<HTMLButtonElement>('[data-testid="add-seat"]');
    if (add) add.disabled = slots.length >= MAX_PLAYERS;
    if (this.startBtn) {
      const open = slots.filter((s) => s.kind === 'open').length;
      this.startBtn.disabled = slots.length < 2 || open > 0;
      this.status.textContent = open > 0 ? `${open} open seat${open > 1 ? 's' : ''} — wait for friends or fill with bots` : `${slots.length} players ready`;
    }
  }

  /** Replace the lobby with an error and a Back button. */
  error(message: string) {
    this.card.replaceChildren(el('h1', '', 'Lobby'), Object.assign(el('div', 'lobby-error', message), { title: message }));
    this.card.lastElementChild!.setAttribute('data-testid', 'lobby-error');
    const back = el('button', 'btn', 'Back to menu');
    back.onclick = () => location.reload();
    this.card.append(back);
  }

  remove() {
    this.root.remove();
  }
}

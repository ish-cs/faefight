import type { Slot } from '../net/protocol';
import { CHAT_MAX_LEN, MAX_PLAYERS } from '../net/protocol';
import type { Difficulty } from '../sim/types';
import { MAP_NAMES, MAP_TEMPLATES, type MapChoice } from '../sim/map';
import { ISLAND_COLORS, ISLAND_NAMES } from './colors';
import { seatSlider, slotToStop, stopToSlot } from './seatSlider';

export type LobbyActions = {
  setSeat(i: number, slot: Slot): void;
  addSeat(): void;
  removeSeat(i: number): void;
  kick(i: number): void;
  setMap(choice: MapChoice): void;
  start(): void;
  back(): void;
};

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const LOBBY_CHAT_LINES = 3;
/** Lobby tag: "easy", "medium", "hard", "PRO". */
const diffTag = (d: Difficulty) => (d === 'pro' ? 'PRO' : d);

const choiceName = (c: MapChoice) => (c === 'random' ? 'Random' : MAP_NAMES[c]);

/** Map dropdown: every template, plus Random (a different map than last time, each match). */
export function mapSelect(value: MapChoice, onChange: (c: MapChoice) => void): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'seat-select map-select';
  for (const [v, label] of [...MAP_TEMPLATES.map((t) => [t, MAP_NAMES[t]]), ['random', 'Random']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.append(o);
  }
  sel.value = value;
  sel.onchange = () => onChange(sel.value as MapChoice);
  return sel;
}

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
  private mapRow = el('div', 'lobby-map');
  private mapSel: HTMLSelectElement | null = null;
  private mapText = el('span', 'lobby-map-name');
  private feed = el('div', 'lobby-feed');
  /** Slider stop per seat at the last render, so a re-render slides the thumb from where it was. */
  private stops = new Map<number, number>();

  /** send: a line typed in the lobby's chat box (chat or a /command); omitted = no chat box. */
  constructor(parent: HTMLElement, code: string, private actions: LobbyActions | null, back: () => void, send?: (text: string) => void) {
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
    this.mapRow.append(el('span', 'label', 'Map'));
    if (actions) {
      this.mapSel = mapSelect('harbor', (c) => actions.setMap(c));
      this.mapSel.dataset.testid = 'lobby-map';
      this.mapRow.append(this.mapSel);
    } else {
      this.mapText.dataset.testid = 'lobby-map-name';
      this.mapRow.append(this.mapText);
    }
    this.card.append(el('h1', '', 'Lobby'), title, codeRow, hint, this.mapRow, this.list, this.status, this.footer);
    if (send) {
      // Below the buttons, fixed height: lines arriving never move anything.
      const box = el('div', 'lobby-chat');
      this.feed.dataset.testid = 'lobby-feed';
      const input = el('input', 'text-in lobby-chat-in');
      input.dataset.testid = 'lobby-chat-input';
      input.maxLength = CHAT_MAX_LEN;
      input.placeholder = actions ? 'Chat, or /help for commands (/spectate)' : 'Chat, or /help for commands';
      input.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const text = input.value.trim();
        input.value = '';
        if (text) send(text);
      };
      box.append(this.feed, input);
      this.card.append(box);
    }
    this.root.append(this.card);
    parent.append(this.root);
  }

  render(slots: Slot[], you: number, map: MapChoice = 'harbor') {
    const a = this.actions;
    if (this.mapSel) { this.mapSel.value = map; this.mapSel.disabled = false; }
    this.mapText.textContent = choiceName(map);
    if (!this.startBtn) { this.status.textContent = 'Waiting for host…'; delete this.status.dataset.testid; }
    // Seats are rebuilt on every change: keep keyboard focus on the same control.
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.testid : undefined;
    const prevStops = this.stops;
    this.stops = new Map();
    // A spectating host gets no island: the playing seats are numbered (and coloured) from 0 without it.
    let island = 0;
    this.list.replaceChildren(...slots.map((s, i) => {
      const row = el('div', 'seat');
      row.dataset.testid = `seat-${i}`;
      const spectator = s.kind === 'human' && !!s.spectator;
      const dot = el('span', spectator ? 'dot spectator' : 'dot');
      if (spectator) dot.title = 'Spectating: no island';
      else {
        const k = island++;
        dot.style.background = hex(ISLAND_COLORS[k % 8]);
        dot.title = ISLAND_NAMES[k % 8];
      }
      row.classList.toggle('spectating', spectator);
      const name = el('span', 'seat-name');
      if (s.kind === 'human') {
        name.append(el('span', 'nick', s.name));
        if (s.isHost) name.append(el('span', 'tagpill', 'host'));
        if (spectator) name.append(Object.assign(el('span', 'tagpill spectator', 'spectator'), { title: 'Hosts the match without playing' }));
        if (i === you) name.append(el('span', 'tagpill you', 'you'));
      } else if (s.kind === 'bot') {
        name.append(el('span', 'nick', s.name ?? 'Bot'));
        // The host's slider already shows the difficulty.
        name.append(el('span', 'tagpill', a ? 'bot' : `bot · ${diffTag(s.difficulty)}`));
      }
      else { name.textContent = 'Open'; name.classList.add('open'); }
      row.append(dot, name);
      if (a && i > 0 && s.kind !== 'human') {
        const stop = slotToStop(s);
        this.stops.set(i, stop);
        const slider = seatSlider(stop, (k) => a.setSeat(i, stopToSlot(k)), prevStops.get(i) ?? stop);
        slider.dataset.testid = `seat-slider-${i}`;
        const rm = el('button', 'btn small icon', '✕');
        rm.title = 'Remove seat';
        rm.dataset.testid = `remove-seat-${i}`;
        rm.disabled = slots.length <= 2;
        rm.onclick = () => a.removeSeat(i);
        row.append(slider, rm);
      }
      if (a && i > 0 && s.kind === 'human') {
        const kick = el('button', 'btn small', 'Kick');
        kick.dataset.testid = `kick-${i}`;
        kick.onclick = () => a.kick(i);
        row.append(kick);
      }
      return row;
    }));
    if (focused) this.list.querySelector<HTMLElement>(`[data-testid="${focused}"]`)?.focus();
    const add = this.footer.querySelector<HTMLButtonElement>('[data-testid="add-seat"]');
    if (add) add.disabled = slots.length >= MAX_PLAYERS;
    if (this.startBtn) {
      const open = slots.filter((s) => s.kind === 'open').length;
      const players = slots.filter((s) => !(s.kind === 'human' && s.spectator)).length;
      this.startBtn.disabled = players < 2 || open > 0;
      this.status.textContent = open > 0 ? `${open} open seat${open > 1 ? 's' : ''} — wait for friends or fill with bots`
        : players < 2 ? 'Add a seat: you are spectating, so at least 2 other players are needed'
        : `${players} players ready${players < slots.length ? ' · you are spectating' : ''}`;
    }
  }

  /** The host started: show which map is loading. */
  loading(mapName: string) {
    this.status.textContent = `Loading ${mapName}…`;
    this.status.dataset.testid = 'lobby-loading';
    if (this.mapSel) this.mapSel.disabled = true;
    this.mapText.textContent = mapName;
  }

  /** A chat line in the lobby's chat box (from = '' → system line). Text only, never HTML. */
  addChat(from: string, text: string) {
    const line = el('div', from ? 'lobby-line' : 'lobby-line system');
    if (from) line.append(el('span', 'chat-from', `${from}: `));
    line.append(el('span', '', text));
    this.feed.append(line);
    while (this.feed.childElementCount > LOBBY_CHAT_LINES) this.feed.firstElementChild!.remove();
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

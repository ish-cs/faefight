import type { Slot } from '../net/protocol';
import { CHAT_MAX_LEN, MAX_PLAYERS } from '../net/protocol';
import type { Difficulty } from '../sim/types';
import { MAP_NAMES, MAP_TEMPLATES, type MapChoice } from '../sim/map';
import { ISLAND_COLORS, ISLAND_NAMES } from './colors';
import { seatSlider, slotToStop, stopToSlot } from './seatSlider';
import { seatColors } from '../net/lobby';
import { DEFAULT_SETTINGS, type GameSettings } from '../sim/settings';
import { GameSettingsPanel } from './gameSettingsUi';
import { isMuted, toggleMute } from './chatMute';

export type LobbyActions = {
  setSeat(i: number, slot: Slot): void;
  addSeat(): void;
  removeSeat(i: number): void;
  kick(i: number): void;
  setMap(choice: MapChoice): void;
  /** The host's own colour (seat 0). */
  setColor(color: number): void;
  setSettings(s: GameSettings): void;
  start(): void;
  back(): void;
};

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const LOBBY_CHAT_LINES = 3;
/** Lobby tag: "easy", "medium", "hard", "PRO". */
const diffTag = (d: Difficulty) => (d === 'pro' ? 'PRO' : d);

const choiceName = (c: MapChoice) => (c === 'random' ? 'Random' : MAP_NAMES[c]);

/** A joined guest's lobby controls. */
export type GuestActions = { setReady(ready: boolean): void; setColor(color: number): void };

/** Offline-rendered map thumbnail (public/maps, made by tests/visual/mapThumbs.mjs); Random has none. */
export const mapThumbUrl = (c: MapChoice): string | null => (c === 'random' ? null : `${import.meta.env.BASE_URL}maps/${c}.jpg`);

/** Start button text: everyone ready → "Start match"; else "Start anyway (2 not ready)". */
export const startLabel = (notReady: number) => (notReady > 0 ? `Start anyway (${notReady} not ready)` : 'Start match');

/** Colours another human seat picked (greyed out in your swatch row). */
export function takenColors(slots: Slot[], you: number): Set<number> {
  return new Set(slots.flatMap((s, i) => (i !== you && s.kind === 'human' && s.color !== undefined ? [s.color] : [])));
}

/**
 * Map picker: a segmented control [Harbor] [Container Yard] [Random], the chosen one highlighted (no dropdowns).
 * Random plays a different map than last time, each match. Buttons are `${testid}-${choice}`.
 */
export class MapPicker {
  readonly root = el('div', 'map-picker');
  private buttons = new Map<MapChoice, HTMLButtonElement>();
  private current: MapChoice;

  constructor(value: MapChoice, testid: string, private onChange: (c: MapChoice) => void) {
    this.current = value;
    this.root.setAttribute('role', 'radiogroup');
    this.root.setAttribute('aria-label', 'Map');
    this.root.dataset.testid = testid;
    for (const c of [...MAP_TEMPLATES, 'random'] as MapChoice[]) {
      const b = el('button', 'map-opt', choiceName(c));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.testid = `${testid}-${c}`;
      b.dataset.value = c;
      b.onclick = () => { if (c !== this.current) { this.value = c; this.onChange(c); } };
      this.buttons.set(c, b);
      this.root.append(b);
    }
    this.value = value;
  }

  get value(): MapChoice { return this.current; }
  set value(c: MapChoice) {
    this.current = c;
    this.root.dataset.value = c;
    for (const [k, b] of this.buttons) { b.classList.toggle('selected', k === c); b.setAttribute('aria-checked', String(k === c)); }
  }
  set disabled(d: boolean) { for (const b of this.buttons.values()) b.disabled = d; }
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
  private mapSel: MapPicker | null = null;
  private mapText = el('span', 'lobby-map-name');
  private feed = el('div', 'lobby-feed');
  private thumb = el('div', 'map-thumb');
  private swatches = el('div', 'swatches');
  private readyBtn: HTMLButtonElement | null = null;
  private ready = false;
  private settingsPanel: GameSettingsPanel;
  /** Slider stop per seat at the last render, so a re-render slides the thumb from where it was. */
  private stops = new Map<number, number>();

  /** send: a line typed in the lobby's chat box (chat or a /command); omitted = no chat box. */
  constructor(parent: HTMLElement, code: string, private actions: LobbyActions | null, back: () => void, send?: (text: string) => void,
    private guest: GuestActions | null = null) {
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
      if (guest) {
        const r = this.readyBtn = el('button', 'btn primary toggle', 'Ready');
        r.type = 'button';
        r.dataset.testid = 'ready-toggle';
        r.setAttribute('aria-pressed', 'false');
        r.onclick = () => guest.setReady(!this.ready);
        this.footer.append(r);
      }
    }
    this.thumb.dataset.testid = 'map-thumb';
    this.mapRow.append(this.thumb, el('span', 'label', 'Map'));
    if (actions) {
      this.mapSel = new MapPicker('harbor', 'lobby-map', (c) => actions.setMap(c));
      this.mapRow.append(this.mapSel.root);
    } else {
      this.mapText.dataset.testid = 'lobby-map-name';
      this.mapRow.append(this.mapText);
    }
    this.settingsPanel = new GameSettingsPanel(DEFAULT_SETTINGS, actions ? (st) => actions.setSettings(st) : null, 'lobby-settings');
    this.swatches.dataset.testid = 'color-swatches';
    const colorRow = el('div', 'color-row');
    colorRow.append(el('span', 'label', 'Your colour'), this.swatches);
    // Wide screens: seats on the left, map / colour / game settings on the right (the card stays as tall as before).
    const side = el('div', 'lobby-side');
    side.append(this.mapRow, colorRow, this.settingsPanel.root);
    const body = el('div', 'lobby-body');
    body.append(this.list, side);
    this.card.append(el('h1', '', 'Lobby'), title, codeRow, hint, body, this.status, this.footer);
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

  render(slots: Slot[], you: number, map: MapChoice = 'harbor', settings: GameSettings = DEFAULT_SETTINGS) {
    const a = this.actions;
    if (this.mapSel) { this.mapSel.value = map; this.mapSel.disabled = false; }
    this.mapText.textContent = choiceName(map);
    this.renderThumb(map);
    this.settingsPanel.value = settings;
    this.settingsPanel.disabled = false;
    const colors = seatColors(slots);
    this.renderSwatches(slots, you, colors[you] ?? null);
    const me = slots[you];
    this.ready = me?.kind === 'human' && !!me.ready;
    if (this.readyBtn) {
      this.readyBtn.textContent = this.ready ? 'Ready ✓' : 'Ready';
      this.readyBtn.classList.toggle('selected', this.ready);
      this.readyBtn.setAttribute('aria-pressed', String(this.ready));
    }
    if (!this.startBtn) { this.status.textContent = 'Waiting for host…'; delete this.status.dataset.testid; }
    // Seats are rebuilt on every change: keep keyboard focus on the same control.
    const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.testid : undefined;
    const prevStops = this.stops;
    this.stops = new Map();
    // A spectating host has no colour; everyone else plays in seatColors' colour (picked, or the lowest free).
    this.list.replaceChildren(...slots.map((s, i) => {
      const row = el('div', 'seat');
      row.dataset.testid = `seat-${i}`;
      const spectator = s.kind === 'human' && !!s.spectator;
      const dot = el('span', spectator ? 'dot spectator' : 'dot');
      const k = colors[i];
      if (spectator || k === null) dot.title = 'Spectating: no island';
      else {
        dot.style.background = hex(ISLAND_COLORS[k]);
        dot.title = ISLAND_NAMES[k];
        dot.dataset.color = String(k);
      }
      dot.dataset.testid = `seat-color-${i}`;
      row.classList.toggle('spectating', spectator);
      const name = el('span', 'seat-name');
      if (s.kind === 'human') {
        name.append(el('span', 'nick', s.name));
        if (s.isHost) name.append(el('span', 'tagpill', 'host'));
        if (spectator) name.append(Object.assign(el('span', 'tagpill spectator', 'spectator'), { title: 'Hosts the match without playing' }));
        if (i === you) name.append(el('span', 'tagpill you', 'you'));
        if (!s.isHost) {
          const pill = el('span', s.ready ? 'tagpill ready' : 'tagpill not-ready', s.ready ? 'ready' : 'not ready');
          pill.dataset.testid = `seat-ready-${i}`;
          name.append(pill);
        }
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
      if (s.kind === 'human' && i !== you) {
        // Local mute (this browser only): hides their chat lines here.
        const muted = isMuted(s.name);
        const mute = el('button', muted ? 'btn small toggle selected' : 'btn small toggle', muted ? 'Muted' : 'Mute');
        mute.type = 'button';
        mute.title = muted ? 'Show their chat again' : 'Hide their chat (only for you)';
        mute.setAttribute('aria-pressed', String(muted));
        mute.dataset.testid = `mute-${i}`;
        mute.onclick = () => {
          const on = toggleMute(s.name);
          mute.textContent = on ? 'Muted' : 'Mute';
          mute.classList.toggle('selected', on);
          mute.setAttribute('aria-pressed', String(on));
        };
        row.append(mute);
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
      const notReady = slots.filter((s) => s.kind === 'human' && !s.isHost && !s.ready).length;
      this.startBtn.disabled = players < 2 || open > 0;
      this.startBtn.textContent = startLabel(notReady);
      this.status.textContent = open > 0 ? `${open} open seat${open > 1 ? 's' : ''} — wait for friends or fill with bots`
        : players < 2 ? 'Add a seat: you are spectating, so at least 2 other players are needed'
        : notReady > 0 ? `${notReady} not ready${players < slots.length ? ' · you are spectating' : ''}`
        : `${players} players ready${players < slots.length ? ' · you are spectating' : ''}`;
    }
  }

  /** The host started: show which map is loading. */
  loading(mapName: string) {
    this.status.textContent = `Loading ${mapName}…`;
    this.status.dataset.testid = 'lobby-loading';
    if (this.mapSel) this.mapSel.disabled = true;
    this.settingsPanel.disabled = true;
    this.mapText.textContent = mapName;
  }

  private renderThumb(map: MapChoice) {
    const url = mapThumbUrl(map);
    this.thumb.dataset.map = map;
    this.thumb.classList.toggle('random', !url);
    if (!url) { this.thumb.replaceChildren(el('span', '', '?')); this.thumb.title = 'Random: a different map each match'; return; }
    const prev = this.thumb.querySelector('img');
    if (prev?.dataset.src === url) return;
    const img = el('img');
    img.alt = choiceName(map);
    img.src = url;
    img.dataset.src = url;
    img.decoding = 'async';
    img.onerror = () => { console.warn(`[lobby] map thumbnail missing: ${url}`); img.remove(); };
    this.thumb.title = choiceName(map);
    this.thumb.replaceChildren(img);
  }

  /** Your colour: 8 swatches; ones another human picked are greyed out. `mine` = the colour you play now. */
  private renderSwatches(slots: Slot[], you: number, mine: number | null) {
    const pick = this.actions ? this.actions.setColor : this.guest?.setColor;
    const taken = takenColors(slots, you);
    this.swatches.replaceChildren(...ISLAND_COLORS.map((c, k) => {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.style.background = hex(c);
      b.title = taken.has(k) ? `${ISLAND_NAMES[k]} (taken)` : ISLAND_NAMES[k];
      b.dataset.testid = `swatch-${k}`;
      b.setAttribute('aria-pressed', String(k === mine));
      b.classList.toggle('selected', k === mine);
      b.classList.toggle('taken', taken.has(k));
      b.disabled = !pick || taken.has(k);
      if (pick) b.onclick = () => { if (k !== mine) pick(k); };
      return b;
    }));
  }

  /** A chat line in the lobby's chat box (from = '' → system line). Text only, never HTML. */
  addChat(from: string, text: string) {
    if (isMuted(from)) return;
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

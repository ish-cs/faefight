import type { PlayerState, Snapshot } from '../sim/types';
import { islandColor } from './colors';

export type ScoreStatus = 'alive' | 'trapped' | 'dead' | 'eliminated' | 'spectating';
export const STATUS_LABEL: Record<ScoreStatus, string> = {
  alive: 'Alive', trapped: 'Trapped', dead: 'Dead', eliminated: 'Eliminated', spectating: 'Spectating',
};

export type ScoreRow = {
  id: number; name: string; island: number; isBot: boolean; isYou: boolean; isHost: boolean;
  kills: number; deaths: number; status: ScoreStatus; sealed: boolean;
};

/** An eliminated human keeps watching (free-fly spectator); an eliminated bot is just out. */
export function statusOf(p: PlayerState): ScoreStatus {
  if (p.eliminated) return p.isBot ? 'eliminated' : 'spectating';
  if (!p.alive) return 'dead';
  return p.breakoutUntil != null ? 'trapped' : 'alive';
}

const GROUP: Record<ScoreStatus, number> = { alive: 0, trapped: 0, dead: 1, eliminated: 2, spectating: 2 };

/** Scoreboard rows: still in it first (alive/trapped, then respawning, then out), then most kills, fewest deaths. */
export function scoreRows(snap: Snapshot, o: { humanId: number; hostId: number | null }): ScoreRow[] {
  return snap.players.map((p): ScoreRow => ({
    id: p.id, name: p.name, island: p.island, isBot: p.isBot, isYou: p.id === o.humanId, isHost: p.id === o.hostId,
    kills: p.kills ?? 0, deaths: p.deaths ?? 0, status: statusOf(p), sealed: !!snap.sealed[p.island],
  })).sort((a, b) => GROUP[a.status] - GROUP[b.status] || b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/** Hold-Tab overlay. Names come from the network: textContent only. */
export class Scoreboard {
  readonly root = el('div', 'scoreboard glass');
  private body = el('tbody');
  private head = el('tr');
  private title = el('div', 'sb-title', 'Scoreboard');
  private sig = '';

  constructor(parent: HTMLElement) {
    this.root.dataset.testid = 'scoreboard';
    this.root.style.display = 'none';
    const table = el('table');
    this.setHead(false);
    table.append(el('thead'), this.body);
    table.tHead!.append(this.head);
    this.root.append(this.title, table);
    parent.append(this.root);
  }

  get visible() { return this.root.style.display !== 'none'; }

  setVisible(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  private setHead(ping: boolean) {
    const cols = ['', 'Player', 'Kills', 'Deaths', 'Status', 'Bunker', ...(ping ? ['Ping'] : [])];
    if (this.head.children.length === cols.length) return;
    this.head.replaceChildren(...cols.map((h) => el('th', '', h)));
  }

  /** Online: `ping(id)` fills a Ping column and `hostTick` goes in the title ("Host tick ok"). */
  update(snap: Snapshot, o: { humanId: number; hostId: number | null; ping?: (id: number) => string; hostTick?: string }) {
    if (!this.visible) return;
    const rows = scoreRows(snap, o);
    const pings = o.ping ? rows.map((r) => o.ping!(r.id)) : null;
    const titleText = o.hostTick ? `Scoreboard · Host tick ${o.hostTick}` : 'Scoreboard';
    const sig = JSON.stringify([rows, pings, titleText]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.setHead(!!pings);
    this.title.textContent = titleText;
    this.title.classList.toggle('strained', o.hostTick === 'strained');
    this.body.replaceChildren(...rows.map((r) => {
      const tr = el('tr', `sb-row ${r.status}${r.isYou ? ' you' : ''}`);
      tr.dataset.testid = `score-${r.id}`;
      const dot = el('span', 'dot');
      dot.style.background = hex(islandColor(r.island));
      const name = el('td', 'sb-name', r.name);
      if (r.isBot) name.append(el('span', 'tagpill', 'BOT'));
      if (r.isHost) name.append(el('span', 'tagpill', 'host'));
      if (r.isYou) name.append(el('span', 'tagpill you', 'you'));
      const dotCell = el('td');
      dotCell.append(dot);
      tr.append(dotCell, name, el('td', 'num', String(r.kills)), el('td', 'num', String(r.deaths)),
        el('td', 'sb-status', STATUS_LABEL[r.status]), el('td', `sb-seal${r.sealed ? ' sealed' : ''}`, r.sealed ? 'Sealed' : 'Open'));
      if (pings) {
        const cell = el('td', 'num sb-ping', pings[rows.indexOf(r)]);
        cell.dataset.testid = `ping-${r.id}`;
        const ms = parseInt(pings[rows.indexOf(r)], 10);
        if (ms > 150) cell.classList.add(ms > 250 ? 'bad' : 'meh');
        tr.append(cell);
      }
      return tr;
    }));
  }
}

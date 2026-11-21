import type { Bunker } from '../sim/map';
import { doorwaysBlocked, type PracticeCmd } from '../sim/practice';
import type { MatchEvent, PieceState, Snapshot } from '../sim/types';
import './practice.css';

/** A string of shots ends after this long without firing; DPS is measured over one string. */
const BURST_GAP_SEC = 2;

/**
 * Practice readout numbers, fed from each snapshot's events: accuracy (trigger pulls that hit someone),
 * headshot share of hits, and damage per second over the latest string of shots (at least 1 s long).
 */
export class PracticeStats {
  shots = 0;
  /** Trigger pulls that hit at least one target (a shotgun blast counts once). */
  hitShots = 0;
  /** Bullet/pellet hits on targets, and how many of them were headshots. */
  hits = 0;
  heads = 0;
  damage = 0;
  private burst: { start: number; last: number; dmg: number } | null = null;

  onEvents(events: readonly MatchEvent[], me: number): void {
    const mine = (e: MatchEvent) => e.data.by === me && e.data.target !== me;
    const hitAt = new Set(events.filter((e) => e.type === 'hit' && mine(e)).map((e) => e.t));
    // Shots first: a shot after a pause starts a new string, and this tick's hits belong to it.
    for (const e of events) {
      if (e.type !== 'shot' || e.data.by !== me || e.data.predicted) continue;
      this.shots++;
      if (hitAt.has(e.t)) this.hitShots++;
      if (!this.burst || e.t - this.burst.last > BURST_GAP_SEC) this.burst = { start: e.t, last: e.t, dmg: 0 };
      else this.burst.last = Math.max(this.burst.last, e.t);
    }
    for (const e of events) {
      if (e.type !== 'hit' || !mine(e)) continue;
      const amount = Number(e.data.amount) || 0;
      this.hits++;
      if (e.data.part === 'head') this.heads++;
      this.damage += amount;
      if (this.burst) { this.burst.dmg += amount; this.burst.last = Math.max(this.burst.last, e.t); }
    }
  }

  get accuracy(): number | null { return this.shots ? this.hitShots / this.shots : null; }
  get headshotRate(): number | null { return this.hits ? this.heads / this.hits : null; }
  get dps(): number | null {
    const b = this.burst;
    return b && b.dmg > 0 ? b.dmg / Math.max(1, b.last - b.start) : null;
  }

  reset(): void {
    this.shots = this.hitShots = this.hits = this.heads = this.damage = 0;
    this.burst = null;
  }
}

export type PracticeActions = {
  send(cmd: PracticeCmd): void;
  /** After a reset or a respawn: look down the lanes again. */
  faceRange(): void;
  /** The panel closed itself (its Resume button): give the game the mouse back. */
  closed(): void;
};

const DOOR_NAMES = ['Front', 'Left', 'Right'];
const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * The practice panel: a readout that is always on screen (stats, last hit, the practice bunker's seal check) and,
 * opened with O, the controls (reset, clear pieces, dummy and shooter toggles). Segmented controls only.
 */
export class PracticePanel {
  readonly root = el('div', 'practice glass');
  readonly stats = new PracticeStats();
  private isOpen = false;
  private bunker: Bunker | null = null;
  private pieceKey = '';
  private statsKey = '';
  private statEls: Record<'acc' | 'head' | 'dps' | 'shots', HTMLElement>;
  private lastHit = el('div', 'practice-last', 'Shoot a target');
  private doors: HTMLElement[] = [];
  private sealState = el('span', 'practice-seal-state');
  private controls = el('div', 'practice-controls');

  constructor(parent: HTMLElement, private act: PracticeActions) {
    this.root.dataset.testid = 'practice-panel';
    const head = el('div', 'practice-head');
    head.append(el('span', 'practice-title', 'Practice range'), el('span', 'practice-keys', 'O  panel · E  shop'));

    const grid = el('div', 'practice-stats');
    const stat = (label: string, id: string) => {
      const box = el('div', 'practice-stat');
      const v = el('div', 'v', '–');
      v.dataset.testid = `practice-${id}`;
      box.append(v, el('div', 'k', label));
      grid.append(box);
      return v;
    };
    this.statEls = { acc: stat('Accuracy', 'accuracy'), head: stat('Headshots', 'headshots'), dps: stat('DPS', 'dps'), shots: stat('Hits / shots', 'shots') };
    this.lastHit.dataset.testid = 'practice-last-hit';

    const seal = el('div', 'practice-seal');
    seal.dataset.testid = 'practice-seal';
    const sealHead = el('div', 'practice-seal-head');
    sealHead.append(el('span', '', 'Bunker seal check'), this.sealState);
    const doors = el('div', 'practice-doors');
    this.doors = DOOR_NAMES.map((name, i) => {
      const d = el('span', 'practice-door', name);
      d.dataset.testid = `practice-door-${i}`;
      doors.append(d);
      return d;
    });
    seal.append(sealHead, doors);

    const btn = (text: string, id: string, onClick: () => void) => {
      const b = el('button', 'btn', text);
      b.type = 'button';
      b.dataset.testid = id;
      b.onclick = onClick;
      return b;
    };
    const row = el('div', 'practice-row');
    row.append(
      btn('Reset range', 'practice-reset', () => { this.act.send({ kind: 'reset' }); this.act.faceRange(); }),
      btn('Clear my pieces', 'practice-clear', () => this.act.send({ kind: 'clearPieces' })),
      btn('Reset stats', 'practice-reset-stats', () => { this.stats.reset(); this.lastHit.textContent = 'Shoot a target'; this.statsKey = ''; }),
    );
    this.controls.append(
      row,
      this.segmented('Dummies', 'practice-dummies', ['On', 'Off'], 0, (i) => this.act.send({ kind: 'dummies', on: i === 0 })),
      this.segmented('Shooter fires', 'practice-shooter', ['On', 'Off'], 0, (i) => this.act.send({ kind: 'shooter', on: i === 0 })),
      btn('Resume', 'practice-resume', () => { this.setOpen(false); this.act.closed(); }),
    );
    this.root.append(head, grid, this.lastHit, seal, this.controls);
    parent.append(this.root);
    this.renderStats();
  }

  get open(): boolean { return this.isOpen; }

  setOpen(open: boolean): void {
    this.isOpen = open;
    this.root.classList.toggle('open', open);
    console.info(`[practice] panel ${open ? 'open' : 'closed'}`);
  }

  setBunker(b: Bunker): void { this.bunker = b; this.pieceKey = ''; }

  onSnapshot(s: Snapshot, me: number): void {
    this.stats.onEvents(s.events, me);
    for (const e of s.events) {
      if (e.type === 'hit' && e.data.by === me && e.data.target !== me) {
        const target = s.players.find((p) => p.id === e.data.target)?.name ?? 'Target';
        const head = e.data.part === 'head';
        this.lastHit.textContent = `${target} · ${head ? 'HEADSHOT' : 'body'} · ${Math.round(Number(e.data.amount) || 0)}`;
        this.lastHit.classList.toggle('head', head);
      }
      if (e.type === 'kill' && e.data.victim === me) this.act.faceRange(); // back at the start: look down the lanes
    }
    this.renderStats();
    this.renderSeal(s.pieces);
  }

  private renderStats() {
    const st = this.stats;
    const key = `${st.shots}|${st.hits}|${st.damage}`;
    if (key === this.statsKey) return;
    this.statsKey = key;
    this.statEls.acc.textContent = pct(st.accuracy);
    this.statEls.head.textContent = pct(st.headshotRate);
    this.statEls.dps.textContent = st.dps === null ? '–' : String(Math.round(st.dps));
    this.statEls.shots.textContent = `${st.hitShots} / ${st.shots}`;
  }

  private renderSeal(pieces: PieceState[]) {
    if (!this.bunker) return;
    let sum = 0;
    for (const p of pieces) sum += p.id;
    const key = `${pieces.length}|${sum}`;
    if (key === this.pieceKey) return;
    this.pieceKey = key;
    const blocked = doorwaysBlocked(this.bunker, pieces);
    blocked.forEach((b, i) => {
      this.doors[i].classList.toggle('blocked', b);
      this.doors[i].dataset.blocked = String(b);
      this.doors[i].textContent = `${DOOR_NAMES[i]} ${b ? '✓' : '✕'}`;
    });
    const n = blocked.filter(Boolean).length;
    this.sealState.textContent = n === blocked.length ? 'SEALED' : `${n} / ${blocked.length} blocked`;
    this.sealState.classList.toggle('sealed', n === blocked.length);
  }

  private segmented(label: string, id: string, options: string[], initial: number, onPick: (i: number) => void): HTMLElement {
    const root = el('div', 'qol-seg practice-seg');
    root.dataset.testid = id;
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', label);
    let cur = initial;
    const buttons = options.map((o, i) => {
      const b = el('button', '', o);
      b.type = 'button';
      b.dataset.testid = `${id}-${o.toLowerCase()}`;
      b.setAttribute('role', 'radio');
      b.onclick = () => { if (cur === i) return; cur = i; sync(); onPick(i); };
      return b;
    });
    const sync = () => buttons.forEach((b, i) => { b.classList.toggle('on', i === cur); b.setAttribute('aria-checked', String(i === cur)); });
    sync();
    seg.append(...buttons);
    root.append(el('span', '', label), seg);
    return root;
  }
}

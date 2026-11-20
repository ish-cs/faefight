import './replay.css';
import { TICK_HZ } from '../../sim/constants';
import type { KillMarker } from './viewerWorker';

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Opts = {
  length: number;
  kills: KillMarker[];
  players: { id: number; name: string }[];
  play(): void;
  pause(): void;
  speed(x: number): void;
  seek(tick: number): void;
  /** null = free camera. */
  follow(id: number | null): void;
  exit(): void;
};

/** Replay playback bar: play/pause, speed, timeline with kill markers, camera target, exit. */
export class ReplayControls {
  readonly root = document.createElement('div');
  private playBtn = document.createElement('button');
  private range = document.createElement('input');
  private time = document.createElement('span');
  private speedSel = document.createElement('select');
  private followSel = document.createElement('select');
  private warn = document.createElement('div');
  private dragging = false;
  private playing = false;

  constructor(parent: HTMLElement, private o: Opts) {
    const r = this.root;
    r.className = 'replay-bar glass';
    r.dataset.testid = 'replay-bar';
    const btn = (text: string, testid: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = text;
      b.dataset.testid = testid;
      b.onclick = onClick;
      return b;
    };
    this.playBtn = btn('Pause', 'replay-play', () => (this.playing ? o.pause() : o.play()));

    const name = (id: number | null) => (id === null ? '?' : o.players.find((p) => p.id === id)?.name ?? `#${id}`);
    const track = document.createElement('div');
    track.className = 'replay-track';
    this.range.type = 'range';
    this.range.min = '1';
    this.range.max = String(Math.max(1, o.length));
    this.range.step = '1';
    this.range.value = '1';
    this.range.dataset.testid = 'replay-seek';
    this.range.oninput = () => { this.dragging = true; this.paintTime(Number(this.range.value)); };
    this.range.onchange = () => { this.dragging = false; o.seek(Number(this.range.value)); };
    const marks = document.createElement('div');
    marks.className = 'replay-marks';
    for (const k of o.kills) {
      const m = document.createElement('button');
      m.className = 'replay-mark';
      m.style.left = `${(100 * k.tick) / Math.max(1, o.length)}%`;
      m.title = `${fmtTime(k.tick / TICK_HZ)} ${k.killer !== null && k.killer !== k.victim ? `${name(k.killer)} eliminated ${name(k.victim)}` : `${name(k.victim)} died`}`;
      m.onclick = () => o.seek(Math.max(1, k.tick - 3 * TICK_HZ)); // a few seconds before
      marks.append(m);
    }
    track.append(marks, this.range);
    this.time.className = 'replay-time';
    this.time.dataset.testid = 'replay-time';

    for (const s of SPEEDS) {
      const op = document.createElement('option');
      op.value = String(s);
      op.textContent = `${s}×`;
      op.selected = s === 1;
      this.speedSel.append(op);
    }
    this.speedSel.className = 'replay-select';
    this.speedSel.dataset.testid = 'replay-speed';
    this.speedSel.onchange = () => o.speed(Number(this.speedSel.value));

    const free = document.createElement('option');
    free.value = '';
    free.textContent = 'Free camera';
    this.followSel.append(free);
    for (const p of o.players) {
      const op = document.createElement('option');
      op.value = String(p.id);
      op.textContent = `Follow ${p.name}`;
      this.followSel.append(op);
    }
    this.followSel.className = 'replay-select';
    this.followSel.dataset.testid = 'replay-follow';
    this.followSel.onchange = () => o.follow(this.followSel.value ? Number(this.followSel.value) : null);

    this.warn.className = 'replay-warn';
    this.warn.dataset.testid = 'replay-diverged';
    this.warn.style.display = 'none';

    const row = document.createElement('div');
    row.className = 'replay-row';
    row.append(this.playBtn, this.time, track, this.speedSel, this.followSel, btn('Exit replay', 'replay-exit', o.exit));
    r.append(row, this.warn);
    // Clicks here must not reach the game canvas (pointer lock / spectator follow-cycling).
    r.addEventListener('mousedown', (e) => e.stopPropagation());
    parent.append(r);
    this.paintTime(1);
  }

  private paintTime(tick: number) {
    this.time.textContent = `${fmtTime(tick / TICK_HZ)} / ${fmtTime(this.o.length / TICK_HZ)}`;
  }

  setState(s: { tick: number; playing: boolean; speed: number; divergedAt: number | null }) {
    this.playing = s.playing;
    this.playBtn.textContent = s.playing ? 'Pause' : 'Play';
    if (!this.dragging) { this.range.value = String(s.tick); this.paintTime(s.tick); }
    if (s.divergedAt !== null && this.warn.style.display === 'none') {
      this.warn.style.display = '';
      this.warn.textContent = `This replay was recorded on a different game version; from ${fmtTime(s.divergedAt / TICK_HZ)} it may not match what happened.`;
    }
  }

  /** The camera stopped following (player died, or WASD took over). */
  setFollow(id: number | null) {
    const v = id === null ? '' : String(id);
    if (this.followSel.value !== v) this.followSel.value = v;
  }
}

import type { MatchEvent, Snapshot, Vec3 } from '../../sim/types';
import type { Motion } from '../characters/avatar';
import { islandColor } from '../colors';
import { eventsBetween, planKillcam, samplePlayer, SnapshotHistory, type KillcamPlan, type PlayerSample } from './killcamBuffer';

/**
 * Killcam: after you die, replays the last seconds before it from your killer's third-person view, out
 * of this client's own snapshot history (killcamBuffer.ts), drawn by the normal renderer (render.ts
 * setReplay). It only ever uses the existing respawn wait (the plan ends before the respawn) and stops at
 * once on Space, on respawn or when the match ends. No killer / not enough of them on record → no killcam.
 * No three.js here (main loads the renderer lazily); main turns the frame into camera + renderer calls.
 */

export type KillcamInfo = { killerName: string; island: number; weapon: string | null; distance: number | null; headshot: boolean };

export type KillcamFrame = {
  /** The recorded frame at or before the playback time (players, pieces, projectiles, hidden). */
  snap: Snapshot;
  motion: (id: number, out: Motion) => Motion | null;
  /** Events crossed since the previous frame (replayed as effects). */
  events: MatchEvent[];
  /** Killer's feet and look angles: where the camera goes. */
  feet: Vec3;
  yaw: number;
  pitch: number;
};

const WEAPON_NAME: Record<string, string> = {
  fists: 'Fists', pistol: 'Pistol', smg: 'SMG', shotgun: 'Shotgun', rifle: 'Rifle', rocket: 'Rocket', grenade: 'Grenade', charge: 'Breach charge',
  barrel: 'Fuel barrel', propane: 'Propane tank',
};
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const el = (tag: string, cls: string, text = '') => { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; };

/** "Killed by X · weapon · distance" (· Headshot). */
export function killcamTitle(i: KillcamInfo): string {
  const parts = [`Killed by ${i.killerName}`];
  if (i.weapon) parts.push(WEAPON_NAME[i.weapon] ?? i.weapon);
  if (i.distance !== null) parts.push(`${i.distance} m`);
  if (i.headshot) parts.push('Headshot');
  return parts.join(' · ');
}

export class Killcam {
  readonly history = new SnapshotHistory();
  private play: { plan: KillcamPlan; killer: number; startMs: number; lastT: number } | null = null;
  private root = el('div', 'qol-killcam');
  private frameEl = el('div', 'qol-killcam-frame');
  private title = el('div', 'kc-title');
  private fill = el('div', 'kc-fill');
  private sample: PlayerSample = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  private feet: Vec3 = { x: 0, y: 0, z: 0 };
  private t = 0;
  private bracket: { a: Snapshot; b: Snapshot; u: number } | null = null;
  /** Debug/e2e: how the last killcam went. */
  last: { started: boolean; reason: string; plan: KillcamPlan | null } = { started: false, reason: 'none', plan: null };

  constructor(private hudRoot: HTMLElement) {
    this.root.dataset.testid = 'killcam';
    const top = el('div', 'kc-top');
    top.append(el('span', 'kc-tag', 'KILLCAM'), el('span', 'kc-skip', 'Space · Skip'));
    const bar = el('div', 'kc-bar');
    bar.append(this.fill);
    this.root.append(top, this.title, bar);
    this.root.style.display = 'none';
    this.frameEl.style.display = 'none';
    hudRoot.append(this.frameEl, this.root);
  }

  /** Every snapshot as it arrives (newest state, before any HUD delay). */
  push(s: Snapshot) { this.history.push(s); }

  get active() { return this.play !== null; }

  /**
   * You died at `deathT`. Starts the killcam if there's a killer on record; `respawnIn` = seconds until
   * the respawn (null: none coming). Returns whether it started.
   */
  start(deathT: number, killer: number | null, respawnIn: number | null, info: KillcamInfo | null, nowMs = performance.now()): boolean {
    this.stop('replaced');
    const plan = planKillcam(this.history.frames, deathT, killer, respawnIn);
    if (!plan || killer === null || !info) {
      this.last = { started: false, reason: killer === null ? 'no killer' : !info ? 'no info' : 'not enough on record', plan: null };
      console.info(`[killcam] skipped: ${this.last.reason}`);
      return false;
    }
    this.play = { plan, killer, startMs: nowMs, lastT: plan.from };
    this.last = { started: true, reason: 'playing', plan };
    this.title.replaceChildren();
    const dot = el('span', 'dot');
    dot.style.background = hex(islandColor(info.island));
    this.title.append(dot, document.createTextNode(killcamTitle(info)));
    this.root.style.display = '';
    this.frameEl.style.display = '';
    this.hudRoot.classList.add('killcam-on');
    console.info(`[killcam] ${plan.duration.toFixed(2)} s from ${plan.from.toFixed(2)} (death ${deathT.toFixed(2)})`);
    return true;
  }

  skip() { this.stop('skipped'); }

  stop(reason: string) {
    if (!this.play) return;
    this.play = null;
    this.bracket = null;
    this.last = { ...this.last, reason };
    this.root.style.display = 'none';
    this.frameEl.style.display = 'none';
    this.hudRoot.classList.remove('killcam-on');
  }

  /** Forget the history (a new match). */
  reset() { this.stop('reset'); this.history.clear(); }

  private motion = (id: number, out: Motion): Motion | null => {
    const b = this.bracket;
    if (!b) return null;
    const s = samplePlayer(b.a, b.b, b.u, id, this.sample);
    if (!s) return null;
    out.pos.set(s.pos.x, s.pos.y, s.pos.z);
    out.vel.set(s.vel.x, s.vel.y, s.vel.z);
    out.yaw = s.yaw;
    out.pitch = s.pitch;
    return out;
  };

  /** Per render frame while active: the replay frame to draw, or null once it has ended (then it's stopped). */
  frame(nowMs = performance.now()): KillcamFrame | null {
    const p = this.play;
    if (!p) return null;
    const t = p.plan.from + (nowMs - p.startMs) / 1000;
    if (t >= p.plan.to) { this.stop('ended'); return null; }
    const b = this.history.bracket(t);
    const k = b ? samplePlayer(b.a, b.b, b.u, p.killer, this.sample) : null;
    if (!b || !k) { this.stop('killer lost'); return null; }
    this.bracket = b;
    this.t = t;
    this.feet.x = k.pos.x; this.feet.y = k.pos.y; this.feet.z = k.pos.z;
    const events = eventsBetween(this.history.frames, p.lastT, t);
    p.lastT = t;
    this.fill.style.transform = `scaleX(${((t - p.plan.from) / p.plan.duration).toFixed(3)})`;
    return { snap: b.a, motion: this.motion, events, feet: this.feet, yaw: k.yaw, pitch: k.pitch };
  }

  info() {
    return { active: this.active, t: this.t, killer: this.play?.killer ?? null, ...this.last, frames: this.history.frames.length };
  }
}

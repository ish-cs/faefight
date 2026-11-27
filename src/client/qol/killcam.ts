import type { MatchEvent, Snapshot, Vec3 } from '../../sim/types';
import type { Motion } from '../characters/avatar';
import { islandColor } from '../colors';
import { ICONS, type IconKind } from '../icons';
import { clamp01, clampToAnchor, smoothDampV3, solveTwoShot, subjectAnchor, type Raycast, type TwoShotOut } from '../camPath';
import {
  eventsBetween, findKillShot, planKillcam, sampleSmooth, slowAmount, slowLead, SLOW_OUT, SnapshotHistory, timeScale,
  type KillcamPlan, type KillShot, type PlayerSample,
} from './killcamBuffer';

/**
 * Killcam: after you die, replays the last seconds before it out of this client's own snapshot history
 * (killcamBuffer.ts), drawn by the normal renderer (render.ts setReplay), as a short cinematic:
 * - camera: a collision-aware two-shot (camPath.ts) easing from a wide establishing angle to over the killer's
 *   shoulder toward you, on critically damped springs (no snaps), horizon level;
 * - players on smooth curves through the recorded snapshots (exact at each one, nothing invented);
 * - slow motion (0.3×) over the killer's final shot(s): the whole last burst (0.45–1 s of sim) eased in and out,
 *   with a small push-in, motion blur (main → renderer, high/ultra), tracers in slow motion, the shot line
 *   emphasised, the world sound ducked and muffled, an impact sound, letterbox bars, a lower-third card and a fade.
 * It only ever uses the existing respawn wait (the plan's real length ends before the respawn) and stops at once
 * on any key / click (after a short grace), on respawn or when the match ends. No killer / not enough of them on
 * record → no killcam. No three.js here (main loads the renderer lazily); main turns the frame into camera +
 * renderer calls and supplies the scene raycast.
 */

export type KillcamInfo = {
  killerName: string; island: number; weapon: string | null; distance: number | null; headshot: boolean;
  /** What the killer had left when you died (death recap). */
  killerHp?: number | null; killerShield?: number | null;
};

export type KillcamFrame = {
  /** The recorded frame at or before the playback time (players, pieces, projectiles, hidden). */
  snap: Snapshot;
  motion: (id: number, out: Motion) => Motion | null;
  /** Events crossed since the previous frame (replayed as effects). */
  events: MatchEvent[];
  /** Camera position and the point it looks at (world up: no roll). */
  cam: Vec3;
  look: Vec3;
  /** FOV multiplier (a small push-in during the slow beat). */
  zoom: number;
  /** 0 = full speed, 1 = slowest (also the motion blur and audio slow-down amount). */
  slow: number;
  /** Playback rate this frame (sim s per real s: 1 = full speed, SLOWMO = slowest). */
  rate: number;
  /** The killing shot's line and how strongly to show it (k 0 = not shown). */
  beam: { from: Vec3; to: Vec3; k: number } | null;
  /** Playback crossed the killing shot this frame (play the impact). */
  impact: boolean;
  headshot: boolean;
};

/** Input in the first this-many seconds doesn't skip (the click / key you were pressing as you died). */
export const SKIP_GRACE = 0.3;
/** Fade in from black at the start, fade to black over the end (real s). */
export const FADE_IN = 0.22, FADE_OUT = 0.4;
/** Camera spring times (real s): position and look point. */
const CAM_SMOOTH = 0.28, LOOK_SMOOTH = 0.16;
/** Push-in at the slowest point (FOV × (1 - ZOOM_IN)). */
const ZOOM_IN = 0.14;

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

/**
 * Camera blend over the replay (0 wide → 1 over the shoulder): a held establishing angle for the first part,
 * then a glide that has arrived shortly before the killing shot.
 */
export function shotBlend(t: number, plan: Pick<KillcamPlan, 'from' | 'killT'>): number {
  const lead = Math.max(0, plan.killT - plan.from);
  const hold = Math.min(0.8, lead * 0.25);
  const arrive = plan.killT - Math.min(0.45, lead * 0.15);
  const span = arrive - (plan.from + hold);
  if (span < 0.2) return 1;
  return clamp01((t - plan.from - hold) / span);
}

/** Black overlay opacity at `real` s into a replay `total` s long. */
export function fadeAt(real: number, total: number): number {
  return clamp01(Math.max(1 - real / FADE_IN, (real - (total - FADE_OUT)) / FADE_OUT));
}

type Play = {
  plan: KillcamPlan; killer: number; victim: number; shot: KillShot;
  t: number; real: number; startMs: number; lastNow: number; lastT: number; first: boolean;
};

export class Killcam {
  readonly history = new SnapshotHistory();
  private play: Play | null = null;
  private root = el('div', 'qol-killcam');
  private frameEl = el('div', 'qol-killcam-frame');
  private fadeEl = el('div', 'qol-killcam-fade');
  private card = el('div', 'kc-card');
  private fill = el('div', 'kc-fill');
  private sample: PlayerSample = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  private vSample: PlayerSample = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
  private bracket: { a: Snapshot; b: Snapshot; u: number; i: number } | null = null;
  private victimAt: Vec3 = { x: 0, y: 0, z: 0 };
  private sol: TwoShotOut = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, side: 1, clear: true };
  private camPos: Vec3 = { x: 0, y: 0, z: 0 };
  private camVel: Vec3 = { x: 0, y: 0, z: 0 };
  private lookPos: Vec3 = { x: 0, y: 0, z: 0 };
  private lookVel: Vec3 = { x: 0, y: 0, z: 0 };
  private anchor: Vec3 = { x: 0, y: 0, z: 0 };
  private out: KillcamFrame;
  private beam = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, k: 0 };
  private shownFade = -1;
  private shownSlow = -1;
  private side: 1 | -1 = 1;
  /** Debug/e2e: how the last killcam went. */
  last: { started: boolean; reason: string; plan: KillcamPlan | null } = { started: false, reason: 'none', plan: null };
  /** Debug/e2e: the camera's minimum clearance this replay (both players seen from it every frame?). */
  stats = { frames: 0, blocked: 0, maxStep: 0, slowFrames: 0, clampMax: 0, sideSwitches: 0, slowReal: 0 };

  constructor(private hudRoot: HTMLElement) {
    this.root.dataset.testid = 'killcam';
    const head = el('div', 'kc-head');
    head.append(el('span', 'kc-tag', 'KILLCAM'), el('span', 'kc-skip', 'Any key · Skip'));
    const bar = el('div', 'kc-bar');
    bar.append(this.fill);
    this.root.append(head, this.card, bar);
    this.root.style.display = 'none';
    this.frameEl.style.display = 'none';
    this.fadeEl.style.opacity = '0';
    this.out = {
      snap: null as unknown as Snapshot, motion: this.motion, events: [], cam: { x: 0, y: 0, z: 0 }, look: this.lookPos, zoom: 1, slow: 0, rate: 1,
      beam: null, impact: false, headshot: false,
    };
    hudRoot.append(this.frameEl, this.root, this.fadeEl);
  }

  /** Every snapshot as it arrives (newest state, before any HUD delay). */
  push(s: Snapshot) { this.history.push(s); }

  get active() { return this.play !== null; }
  /** Whose kill is playing (-1: none). */
  get killer() { return this.play?.killer ?? -1; }

  /**
   * `victim` died at `deathT`. Starts the killcam if there's a killer on record; `respawnIn` = seconds until
   * the respawn (null: none coming). Returns whether it started.
   */
  start(deathT: number, killer: number | null, respawnIn: number | null, info: KillcamInfo | null, nowMs = performance.now(), victim = -1): boolean {
    this.stop('replaced');
    const shot = killer !== null ? findKillShot(this.history.frames, deathT, killer, victim) : null;
    const plan = shot ? planKillcam(this.history.frames, deathT, killer, respawnIn, shot.t, slowLead(shot)) : null;
    if (!plan || !shot || killer === null || !info) {
      this.last = { started: false, reason: killer === null ? 'no killer' : !info ? 'no info' : 'not enough on record', plan: null };
      console.info(`[killcam] skipped: ${this.last.reason}`);
      return false;
    }
    this.play = { plan, killer, victim, shot, t: plan.from, real: 0, startMs: nowMs, lastNow: nowMs, lastT: plan.from, first: true };
    this.last = { started: true, reason: 'playing', plan };
    this.stats = { frames: 0, blocked: 0, maxStep: 0, slowFrames: 0, clampMax: 0, sideSwitches: 0, slowReal: 0 };
    this.side = 1;
    this.buildCard(info, shot.headshot || info.headshot);
    this.fill.style.transform = 'scaleX(0)';
    this.root.style.display = '';
    this.frameEl.style.display = '';
    this.fadeEl.classList.remove('out');
    this.setFade(1);
    this.hudRoot.classList.add('killcam-on');
    console.info(`[killcam] ${plan.real.toFixed(2)} s real (${plan.duration.toFixed(2)} s sim from ${plan.from.toFixed(2)}, shot ${shot.t.toFixed(2)}, slow lead ${plan.lead.toFixed(2)}, death ${deathT.toFixed(2)})`);
    return true;
  }

  private buildCard(info: KillcamInfo, headshot: boolean) {
    const c = this.card;
    c.replaceChildren();
    c.title = killcamTitle(info);
    const color = hex(islandColor(info.island));
    c.style.setProperty('--kc-color', color);
    const icon = el('span', 'kc-icon');
    if (info.weapon && Object.hasOwn(ICONS, info.weapon)) icon.innerHTML = ICONS[info.weapon as IconKind];
    else icon.textContent = '✕';
    const main = el('div', 'kc-main');
    main.append(el('div', 'kc-by', 'Killed by'), el('div', 'kc-name', info.killerName));
    const facts = el('div', 'kc-facts');
    if (info.weapon) facts.append(el('span', 'kc-fact', WEAPON_NAME[info.weapon] ?? info.weapon));
    if (info.distance !== null) facts.append(el('span', 'kc-fact', `${info.distance} m`));
    if (headshot) facts.append(el('span', 'kc-hs', 'Headshot'));
    if (facts.childElementCount) main.append(facts);
    c.append(el('span', 'kc-strip'), icon, main);
    if (info.killerHp !== null && info.killerHp !== undefined) {
      const left = el('div', 'kc-left');
      left.dataset.testid = 'killcam-killer-hp';
      left.append(el('span', 'kc-k', 'They had'));
      const hp = el('div', 'kc-meter hp');
      const hpFill = el('span', '');
      hpFill.style.width = `${Math.max(0, Math.min(100, info.killerHp))}%`;
      hp.append(hpFill);
      left.append(hp, el('span', 'kc-v', `${info.killerHp} HP`));
      if (info.killerShield) {
        const sh = el('div', 'kc-meter sh');
        const shFill = el('span', '');
        shFill.style.width = `${Math.max(0, Math.min(100, info.killerShield))}%`;
        sh.append(shFill);
        left.append(sh, el('span', 'kc-v sh', `+${info.killerShield}`));
      }
      c.append(left);
    }
  }

  private setFade(v: number) {
    const q = Math.round(v * 50) / 50;
    if (q === this.shownFade) return;
    this.shownFade = q;
    this.fadeEl.style.opacity = String(q);
  }

  /** Any key / click: skips once past the grace period. Returns whether it skipped. */
  trySkip(nowMs = performance.now()): boolean {
    const p = this.play;
    if (!p || Math.max(p.real, (nowMs - p.startMs) / 1000) < SKIP_GRACE) return false;
    this.stop('skipped');
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
    // Fade to the live view (from black when it ran to the end).
    this.fadeEl.classList.add('out');
    this.shownFade = -1;
    this.fadeEl.style.opacity = '0';
    this.hudRoot.classList.remove('killcam-on');
  }

  /** Forget the history (a new match). */
  reset() { this.stop('reset'); this.history.clear(); }

  private motion = (id: number, out: Motion): Motion | null => {
    const b = this.bracket, p = this.play;
    if (!b) return null;
    const s = sampleSmooth(this.history.frames, b.i, b.u, id, this.sample);
    if (!s) return null;
    // Velocity drives the walk cycle: slowed with the playback, so feet don't skate in slow motion.
    const k = p ? timeScale(p.t, p.plan.killT, p.plan.lead) : 1;
    out.pos.set(s.pos.x, s.pos.y, s.pos.z);
    out.vel.set(s.vel.x * k, s.vel.y * k, s.vel.z * k);
    out.yaw = s.yaw;
    out.pitch = s.pitch;
    return out;
  };

  /**
   * Per render frame while active: the replay frame to draw, or null once it has ended (then it's stopped).
   * `raycast`: the scene's blockers (camPath.Raycast); omitted, the camera ignores geometry.
   */
  frame(nowMs = performance.now(), raycast: Raycast = () => null): KillcamFrame | null {
    const p = this.play;
    if (!p) return null;
    const dt = p.first ? 0 : Math.min(0.25, Math.max(0, (nowMs - p.lastNow) / 1000));
    p.lastNow = nowMs;
    p.real += dt;
    const rate = timeScale(p.t, p.plan.killT, p.plan.lead);
    p.t += dt * rate;
    if (p.t >= p.plan.to || p.real >= p.plan.real + 0.25) { this.stop('ended'); return null; }
    const b = this.history.bracket(p.t);
    const k = b ? sampleSmooth(this.history.frames, b.i, b.u, p.killer, this.sample) : null;
    if (!b || !k) { this.stop('killer lost'); return null; }
    this.bracket = b;
    const kx = k.pos.x, ky = k.pos.y, kz = k.pos.z;
    const v = sampleSmooth(this.history.frames, b.i, b.u, p.victim, this.vSample);
    if (v) { this.victimAt.x = v.pos.x; this.victimAt.y = v.pos.y; this.victimAt.z = v.pos.z; }
    else if (p.first) {
      // Victim not on record (spectated far away): look where the killer looks, 12 m out.
      this.victimAt.x = kx - Math.sin(k.yaw) * 12; this.victimAt.y = ky; this.victimAt.z = kz - Math.cos(k.yaw) * 12;
    }
    const kFeet = this.anchor; kFeet.x = kx; kFeet.y = ky; kFeet.z = kz;
    const sol = solveTwoShot({ subject: kFeet, target: this.victimAt, blend: shotBlend(p.t, p.plan), side: this.side, switchCost: p.first ? 0 : 30, raycast }, this.sol);
    if (sol.side !== this.side && !p.first) this.stats.sideSwitches++;
    this.side = sol.side;
    const o = this.out;
    if (p.first) {
      this.camPos.x = sol.pos.x; this.camPos.y = sol.pos.y; this.camPos.z = sol.pos.z;
      this.lookPos.x = sol.look.x; this.lookPos.y = sol.look.y; this.lookPos.z = sol.look.z;
      this.camVel.x = this.camVel.y = this.camVel.z = 0;
      this.lookVel.x = this.lookVel.y = this.lookVel.z = 0;
    } else {
      smoothDampV3(this.camPos, sol.pos, this.camVel, CAM_SMOOTH, dt);
      smoothDampV3(this.lookPos, sol.look, this.lookVel, LOOK_SMOOTH, dt);
    }
    // Never inside geometry: the smoothed camera is pulled in front of anything between it and the killer.
    const prevX = o.cam.x, prevY = o.cam.y, prevZ = o.cam.z;
    o.cam.x = this.camPos.x; o.cam.y = this.camPos.y; o.cam.z = this.camPos.z;
    this.stats.clampMax = Math.max(this.stats.clampMax, clampToAnchor(subjectAnchor(kFeet, this.anchor), o.cam, raycast));
    if (!p.first) this.stats.maxStep = Math.max(this.stats.maxStep, Math.hypot(o.cam.x - prevX, o.cam.y - prevY, o.cam.z - prevZ) / Math.max(dt, 1e-3));
    this.stats.frames++;
    if (!sol.clear) this.stats.blocked++;
    const slow = slowAmount(p.t, p.plan.killT, p.plan.lead);
    if (slow > 0.5) this.stats.slowFrames++;
    if (slow > 0.9) this.stats.slowReal += dt;
    o.snap = b.a;
    o.events = eventsBetween(this.history.frames, p.lastT, p.t);
    o.impact = p.lastT < p.plan.killT && p.t >= p.plan.killT;
    o.headshot = p.shot.headshot;
    o.zoom = 1 - ZOOM_IN * slow;
    o.slow = slow;
    o.rate = rate;
    const sh = p.shot;
    if (sh.from && sh.to && p.t >= sh.t - 0.02 && p.t <= p.plan.killT + SLOW_OUT + 0.3) {
      const bm = this.beam;
      bm.from.x = sh.from.x; bm.from.y = sh.from.y; bm.from.z = sh.from.z;
      bm.to.x = sh.to.x; bm.to.y = sh.to.y; bm.to.z = sh.to.z;
      bm.k = Math.max(slow, clamp01(1 - (p.t - sh.t) / 0.6));
      o.beam = bm;
    } else o.beam = null;
    p.lastT = p.t;
    p.first = false;
    this.fill.style.transform = `scaleX(${Math.min(1, p.real / p.plan.real).toFixed(3)})`;
    this.setFade(fadeAt(p.real, p.plan.real));
    const sq = Math.round(slow * 20) / 20;
    if (sq !== this.shownSlow) { this.shownSlow = sq; this.frameEl.style.setProperty('--kc-slow', String(sq)); }
    return o;
  }

  info() {
    const p = this.play;
    return { active: this.active, t: p?.t ?? 0, real: p?.real ?? 0, slow: p ? slowAmount(p.t, p.plan.killT, p.plan.lead) : 0, killer: p?.killer ?? null,
      ...this.last, frames: this.history.frames.length, stats: this.stats };
  }
}

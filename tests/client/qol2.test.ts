import { describe, expect, it } from 'vitest';
import { emptyInventory } from '../../src/sim/economy';
import { buildMap } from '../../src/sim/map';
import type { MatchEvent, MatchEventType, PlayerState, Snapshot, Vec3 } from '../../src/sim/types';
import { FEED_LIFE_MS, FEED_MAX, FeedList, feedEntries, feedText, type FeedCtx } from '../../src/client/qol/killFeed';
import {
  eventsBetween, HISTORY_SEC, KILLCAM_MIN_SEC, KILLCAM_SEC, planKillcam, RESPAWN_MARGIN, samplePlayer, SnapshotHistory, TAIL_SEC,
} from '../../src/client/qol/killcamBuffer';
import { killcamTitle } from '../../src/client/qol/killcam';
import { ENEMY_STEP_GAIN, isLanding, landGain, SoundDirector, type Cue } from '../../src/client/audio/events';
import { HEARING, muffleCutoff, MUFFLE_FLOOR, VoiceLimiter, voicePriority, withinHearing } from '../../src/client/audio/voices';

const ME = 1, A = 2, B = 3;

function player(id: number, pos: Vec3, extra: Partial<PlayerState> = {}): PlayerState {
  return {
    id, name: `p${id}`, isBot: id !== ME, island: id - 1, pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, hp: 100, shield: 0,
    alive: true, eliminated: false, kills: 0, deaths: 0, respawnAt: null, breakoutUntil: null, invulnUntil: 0, lastDamagedAt: 0,
    inv: { ...emptyInventory(), cash: 50 }, vault: emptyInventory(), locked: [], hotbar: Array(9).fill(null), selected: 0, equipped: 'fists', healAt: null, drinking: null, healLeft: 0, speedUntil: 0, reloadUntil: 0, reloadSec: 0, reloadMag: 0, nextFireAt: 0, busyUntil: 0, ads: false, bloom: 0, lastShotAt: -1e9, burst: 0, stamina: 100,
    ...extra,
  };
}

function snap(time: number, players: PlayerState[], events: [MatchEventType, Record<string, unknown>][] = [], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    time, tick: Math.round(time * 30), players, pieces: [], loot: [], projectiles: [], generators: [], genLevels: [1, 1, 1], sealed: [false, false, false], waterY: 0,
    suddenDeath: false, winner: null, potionShops: [], events: events.map(([type, data]): MatchEvent => ({ t: time, type, data })), ...extra,
  };
}
const ev = (t: number, type: MatchEventType, data: Record<string, unknown>): MatchEvent => ({ t, type, data });

// ---- kill feed ---------------------------------------------------------------------------------

describe('kill feed entries', () => {
  const ctx: FeedCtx = { humanId: ME, ownerOf: (i) => i + 1 };
  const name = (id: number) => (id === ME ? 'You' : `p${id}`);

  it('a gun kill takes the weapon from the killing hit (even listed after the kill), headshot marker', () => {
    const [e] = feedEntries([ev(5, 'kill', { victim: B, killer: A, inWater: false }), ev(5, 'hit', { target: B, by: A, weapon: 'rifle', part: 'head' })], ctx);
    expect(e).toMatchObject({ kind: 'kill', killer: A, victim: B, weapon: 'rifle', markers: ['headshot'], mine: false, me: false });
    expect(feedText(e, name)).toBe('p2 ⟶ p3');
  });

  it("prefers the killer's hit over someone else's in the same tick; ignores hits from other ticks", () => {
    const [e] = feedEntries([
      ev(5, 'hit', { target: B, by: A, weapon: 'smg' }), ev(5, 'hit', { target: B, by: ME, weapon: 'pistol' }),
      ev(4.9, 'hit', { target: B, by: A, weapon: 'rocket' }), ev(5, 'kill', { victim: B, killer: A }),
    ], ctx);
    expect(e.weapon).toBe('smg');
  });

  it('explosions, falls, water, and the storm / lightning by the kill cause', () => {
    expect(feedEntries([ev(1, 'kill', { victim: B, killer: A }), ev(1, 'hit', { target: B, by: A, weapon: 'grenade' })], ctx)[0].markers).toEqual(['explosion']);
    const fall = feedEntries([ev(1, 'kill', { victim: B, killer: null }), ev(1, 'hit', { target: B, by: null, weapon: 'fall' })], ctx)[0];
    expect(fall).toMatchObject({ weapon: null, markers: ['fall'], killer: null });
    expect(feedText(fall, name)).toBe('p3 fell');
    const water = feedEntries([ev(1, 'kill', { victim: ME, killer: null, inWater: true })], ctx)[0];
    expect(water).toMatchObject({ markers: ['water'], me: true });
    expect(feedText(water, name)).toBe('You drowned');
    const storm = feedEntries([ev(1, 'kill', { victim: B, killer: null, inWater: false, cause: 'storm' })], ctx)[0];
    expect(storm.markers).toEqual(['storm']);
    expect(feedText(storm, name)).toBe('p3 was caught in the storm');
    expect(feedEntries([ev(1, 'kill', { victim: B, killer: null, cause: 'lightning' })], ctx)[0].markers).toEqual(['lightning']);
  });

  it('your kills are flagged mine, your deaths me; a suicide has no killer', () => {
    expect(feedEntries([ev(1, 'kill', { victim: B, killer: ME })], ctx)[0]).toMatchObject({ mine: true, me: false });
    expect(feedText(feedEntries([ev(1, 'kill', { victim: B, killer: ME })], ctx)[0], name)).toBe('You ⟶ p3');
    const self = feedEntries([ev(1, 'kill', { victim: B, killer: B }), ev(1, 'hit', { target: B, by: B, weapon: 'rocket' })], ctx)[0];
    expect(self).toMatchObject({ killer: null, weapon: 'rocket', markers: ['explosion'] });
    expect(feedText(self, name)).toBe('p3 blew up');
  });

  it('a barrel someone set off: "X via barrel", marked explosion', () => {
    const e = feedEntries([ev(1, 'kill', { victim: B, killer: A, via: 'barrel' }), ev(1, 'hit', { target: B, by: A, weapon: 'barrel' })], ctx)[0];
    expect(e).toMatchObject({ killer: A, weapon: 'barrel', via: 'barrel', markers: ['explosion'] });
    expect(feedText(e, name)).toBe('p2 via barrel ⟶ p3');
    const self = feedEntries([ev(1, 'kill', { victim: B, killer: B, via: 'propane' }), ev(1, 'hit', { target: B, by: B, weapon: 'propane' })], ctx)[0];
    expect(feedText(self, name)).toBe('p3 blew up via propane');
  });

  it('seal entries: who sealed whose bunker; yours highlighted either way', () => {
    const [s] = feedEntries([ev(1, 'sealed', { island: 2, owner: B, by: ME })], ctx);
    expect(s).toMatchObject({ kind: 'sealed', killer: ME, victim: B, island: 2, mine: true, me: false });
    expect(feedText(s, name)).toBe("You sealed p3's bunker");
    const mine = feedEntries([ev(1, 'sealed', { island: 0, by: A })], ctx)[0];
    expect(mine).toMatchObject({ victim: ME, me: true, mine: false });
    expect(feedText(mine, name)).toBe('p2 sealed your bunker');
    expect(feedText(feedEntries([ev(1, 'sealed', { island: 1 })], ctx)[0], name)).toBe("p2's bunker sealed");
  });

  it('other events make no entries; order follows the events', () => {
    const es = feedEntries([ev(1, 'shot', {}), ev(1, 'kill', { victim: A, killer: B }), ev(1, 'unsealed', { island: 0 }), ev(1, 'kill', { victim: B, killer: ME })], ctx);
    expect(es.map((e) => e.victim)).toEqual([A, B]);
  });
});

describe('feed list', () => {
  it('newest first, keeps the last FEED_MAX, returns what fell off', () => {
    const l = new FeedList<number>();
    const off: number[] = [];
    for (let i = 1; i <= FEED_MAX + 2; i++) off.push(...l.push(i, i));
    expect(l.items.map((x) => x.value)).toEqual([7, 6, 5, 4, 3]);
    expect(off).toEqual([1, 2]);
  });

  it('entries expire after FEED_LIFE_MS', () => {
    const l = new FeedList<string>();
    l.push('a', 0);
    l.push('b', 1000);
    expect(l.expire(FEED_LIFE_MS - 1)).toEqual([]);
    expect(l.expire(FEED_LIFE_MS)).toEqual(['a']);
    expect(l.items.map((x) => x.value)).toEqual(['b']);
  });
});

// ---- killcam -----------------------------------------------------------------------------------

/** 30 Hz frames from t0 to t1 with A walking +x at 3 m/s and ME standing; `hiddenWhen` hides A. */
function frames(t0: number, t1: number, hiddenWhen: (t: number) => boolean = () => false): Snapshot[] {
  const out: Snapshot[] = [];
  for (let i = Math.round(t0 * 30); i <= Math.round(t1 * 30); i++) {
    const t = i / 30;
    out.push(snap(t, [player(ME, { x: 0, y: 0, z: 0 }), player(A, { x: 3 * t, y: 0, z: 5 }, { yaw: t })], [], hiddenWhen(t) ? { hidden: [A] } : {}));
  }
  return out;
}

describe('snapshot history', () => {
  it('keeps the last HISTORY_SEC of sim time, ignores out-of-order frames', () => {
    const h = new SnapshotHistory();
    for (const f of frames(0, 10)) h.push(f);
    expect(h.newest).toBeCloseTo(10);
    expect(h.oldest!).toBeGreaterThanOrEqual(10 - HISTORY_SEC - 1e-9);
    expect(h.oldest!).toBeLessThan(10 - HISTORY_SEC + 0.04);
    const n = h.frames.length;
    h.push(snap(9, []));
    expect(h.frames.length).toBe(n);
    expect(h.range(8, 9).every((f) => f.time >= 8 && f.time <= 9)).toBe(true);
  });

  it('bracket: the frames around a time and how far between them', () => {
    const h = new SnapshotHistory();
    for (const f of frames(0, 1)) h.push(f);
    const b = h.bracket(0.5 + 1 / 60)!;
    expect(b.a.time).toBeCloseTo(0.5);
    expect(b.b.time).toBeCloseTo(0.5 + 1 / 30);
    expect(b.u).toBeCloseTo(0.5);
    expect(h.bracket(-1)!.a.time).toBe(0);
    expect(h.bracket(5)!.u).toBe(0);
  });
});

describe('killcam window', () => {
  it('KILLCAM_SEC of real time (slow beat included) when there is no respawn coming; ends a little after the death', () => {
    const p = planKillcam(frames(0, 10), 10, A, null)!;
    expect(p.real).toBeLessThanOrEqual(KILLCAM_SEC + 1e-6);
    expect(p.real).toBeGreaterThan(KILLCAM_SEC - 0.05); // starts on a recorded frame
    expect(p.duration).toBeLessThan(p.real); // the slow beat costs real time
    expect(p.to).toBeCloseTo(10 + TAIL_SEC);
  });

  it('shortened to end before the respawn (respawn timing never changes)', () => {
    const p = planKillcam(frames(0, 10), 10, A, 3)!;
    expect(p.real).toBeLessThanOrEqual(3 - RESPAWN_MARGIN);
    expect(p.real).toBeGreaterThan(3 - RESPAWN_MARGIN - 0.1);
  });

  it('no killcam when the respawn is too soon, or no killer (fall, water, suicide)', () => {
    expect(planKillcam(frames(0, 10), 10, A, KILLCAM_MIN_SEC)).toBeNull();
    expect(planKillcam(frames(0, 10), 10, null, null)).toBeNull();
  });

  it('only as far back as the history goes', () => {
    const p = planKillcam(frames(8, 10), 10, A, null)!;
    expect(p.from).toBeCloseTo(8);
    expect(p.duration).toBeCloseTo(2 + TAIL_SEC);
  });

  it('degrades with interest management: starts where the killer became visible; skips if not visible at the death', () => {
    const p = planKillcam(frames(0, 10, (t) => t < 7.5), 10, A, null)!;
    expect(p.from).toBeCloseTo(7.5 + 1 / 30, 1);
    expect(planKillcam(frames(0, 10, (t) => t > 9.9), 10, A, null)).toBeNull();
    expect(planKillcam(frames(0, 10, (t) => t < 9.5), 10, A, null)).toBeNull(); // only 0.5 s of them: not worth it
  });

  it('a gap in the record longer than MAX_GAP_SEC cuts the start', () => {
    const fs = frames(0, 10).filter((f) => f.time < 6 || f.time > 7);
    expect(planKillcam(fs, 10, A, null)!.from).toBeGreaterThan(7);
  });

  it('samples players between frames; holds across hidden frames and teleports', () => {
    const [a, b] = frames(1, 1 + 1 / 30);
    const s = samplePlayer(a, b, 0.5, A)!;
    expect(s.pos.x).toBeCloseTo(3 * (1 + 1 / 60));
    expect(s.vel.x).toBeCloseTo(3);
    expect(s.yaw).toBeCloseTo(1 + 1 / 60);
    const hidden = { ...b, hidden: [A] };
    expect(samplePlayer(a, hidden, 0.9, A)!.pos.x).toBeCloseTo(3);
    const tp = { ...b, players: [player(A, { x: 50, y: 0, z: 5 })] };
    expect(samplePlayer(a, tp, 0.4, A)!.pos.x).toBeCloseTo(3);
    expect(samplePlayer(a, tp, 0.6, A)!.pos.x).toBeCloseTo(50);
    expect(samplePlayer(a, b, 0.5, 99)).toBeNull();
  });

  it('events replay once each as playback crosses their frames', () => {
    const fs = [snap(1, [], [['shot', { by: A }]]), snap(1.1, [], [['hit', { by: A }]]), snap(1.2, [], [['explosion', {}]])];
    expect(eventsBetween(fs, 0.9, 1.05).map((e) => e.type)).toEqual(['shot']);
    expect(eventsBetween(fs, 1.05, 1.2).map((e) => e.type)).toEqual(['hit', 'explosion']);
    expect(eventsBetween(fs, 1.2, 1.3)).toEqual([]);
  });

  it('banner: "Killed by X · weapon · distance"', () => {
    expect(killcamTitle({ killerName: 'Rex', island: 1, weapon: 'rifle', distance: 23, headshot: true })).toBe('Killed by Rex · Rifle · 23 m · Headshot');
    expect(killcamTitle({ killerName: 'Rex', island: 1, weapon: null, distance: null, headshot: false })).toBe('Killed by Rex');
  });
});

// ---- audio cue rules ---------------------------------------------------------------------------

describe('audio: hearing distance and priority', () => {
  it('enemy steps, landings and reloads are capped; shots and explosions are not; your own always play', () => {
    expect(withinHearing('footstep', HEARING.footstep)).toBe(true);
    expect(withinHearing('footstep', HEARING.footstep + 0.1)).toBe(false);
    expect(withinHearing('reload', 30)).toBe(false);
    expect(withinHearing('land', 30)).toBe(true);
    expect(withinHearing('shot', 110)).toBe(true);
    expect(withinHearing('footstep', 80, true)).toBe(true);
    expect(HEARING.reload).toBeLessThan(HEARING.footstep);
  });

  it('priority: your feedback > enemy position cues > the rest', () => {
    expect(voicePriority('hitmarker', false)).toBe(3);
    expect(voicePriority('headshot', false)).toBe(3);
    expect(voicePriority('footstep', true)).toBe(2);
    expect(voicePriority('land', true)).toBe(2);
    expect(voicePriority('footstep', true, true)).toBe(1); // your own steps
    expect(voicePriority('coin', false)).toBe(1);
  });

  it('a full mix keeps an enemy footstep over a louder ambient-ish cue', () => {
    const l = new VoiceLimiter({ maxVoices: 2, perFrame: 5, minLevel: 0.01 });
    l.admit('coin', 0.5 * voicePriority('coin', false), 0, 5);
    l.admit('impact', 0.45 * voicePriority('impact', true), 0, 5);
    const step = l.admit('footstep', 0.3 * voicePriority('footstep', true), 0, 1);
    expect(step.ok).toBe(true);
  });

  it('low-HP muffle fades in smoothly below 30 HP to a slight floor, and out as you heal', () => {
    expect(muffleCutoff(30)).toBe(20000);
    expect(muffleCutoff(29.9)).toBeGreaterThan(19000);
    expect(muffleCutoff(0)).toBeCloseTo(MUFFLE_FLOOR);
    expect(muffleCutoff(10)).toBeLessThan(muffleCutoff(20));
    expect(muffleCutoff(5, false)).toBe(20000);
  });
});

describe('audio: landing and hit feedback cues', () => {
  const map = buildMap(2);
  const home = map[0].center;
  const at = (dx: number): Vec3 => ({ x: home.x + dx, y: map[0].groundY, z: home.z });
  const director = () => { const d = new SoundDirector(); d.setMap(map, ME); return d; };
  const names = (cs: Cue[]) => cs.map((c) => c.sound);

  it('landing: falling then grounded → a positional thud for others, 2D for you; none for a hop or teleport', () => {
    expect(isLanding(-8, 0, 0.3, true)).toBe(true);
    expect(isLanding(-2, 0, 0.3, true)).toBe(false); // a small hop
    expect(isLanding(-8, -6, 0.3, true)).toBe(false); // still falling
    expect(isLanding(-8, 0, 10, true)).toBe(false); // teleport
    expect(isLanding(-8, 0, 0.3, false)).toBe(false); // into the water
    expect(landGain(-20, false)).toBeGreaterThan(landGain(-6, false));
    const d = director();
    d.update(snap(1, [player(ME, at(0), { vel: { x: 0, y: -9, z: 0 } }), player(A, at(8), { vel: { x: 0, y: -9, z: 0 } })]));
    const cues = d.update(snap(1.04, [player(ME, at(0)), player(A, at(8))])).filter((c) => c.sound === 'land');
    expect(cues.find((c) => c.own)).toMatchObject({ pos: null });
    expect(cues.find((c) => !c.own)?.pos).toMatchObject({ x: at(8).x });
  });

  it('your headshot adds a ding; breaking their shield adds a crack; enemy steps are louder than yours', () => {
    const d = director();
    const ps = [player(ME, at(0)), player(A, at(5))];
    expect(names(d.update(snap(1, ps, [['hit', { target: A, by: ME, amount: 30, part: 'head' }]])))).toEqual(['impact', 'hitmarker', 'headshot']);
    expect(names(d.update(snap(1.1, ps, [['hit', { target: A, by: ME, amount: 30, part: 'head', echo: true }]])))).toEqual(['impact']); // shown when predicted
    expect(ENEMY_STEP_GAIN).toBeGreaterThan(0.4);
  });
});

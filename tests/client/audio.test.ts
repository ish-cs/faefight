import { describe, expect, it } from 'vitest';
import { emptyInventory } from '../../src/sim/economy';
import { buildMap } from '../../src/sim/map';
import type { MatchEvent, MatchEventType, PieceState, PlayerState, Snapshot, Vec3 } from '../../src/sim/types';
import { pieceSurface, shoreDistance, SoundDirector, surfaceAt, type Cue } from '../../src/client/audio/events';
import {
  audibility, distanceCutoff, distanceGain, echoSend, heartbeatInterval, muffleCutoff, VoiceLimiter, waveLevel,
} from '../../src/client/audio/voices';

const ME = 1, BOT = 2;
const map = buildMap(2);

function player(id: number, pos: Vec3, extra: Partial<PlayerState> = {}): PlayerState {
  return {
    id, name: `p${id}`, isBot: id !== ME, island: id - 1, pos, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, hp: 100, shield: 0,
    alive: true, eliminated: false, kills: 0, deaths: 0, respawnAt: null, breakoutUntil: null, invulnUntil: 0, lastDamagedAt: 0,
    inv: { ...emptyInventory(), cash: 50 }, vault: emptyInventory(), locked: [], hotbar: Array(9).fill(null), selected: 0, equipped: 'fists', healAt: null, drinking: null, healLeft: 0, speedUntil: 0, reloadUntil: 0, reloadSec: 0, reloadMag: 0, nextFireAt: 0, busyUntil: 0, ads: false, bloom: 0, lastShotAt: -1e9, burst: 0,
    ...extra,
  };
}

function snap(time: number, players: PlayerState[], events: [MatchEventType, Record<string, unknown>][] = [], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    time, tick: Math.round(time * 30), players, pieces: [], loot: [], projectiles: [], generators: [], genLevels: [1, 1], sealed: [false, false], waterY: 0,
    suddenDeath: false, winner: null, potionShops: [], events: events.map(([type, data]): MatchEvent => ({ t: time, type, data })), ...extra,
  };
}

const home = map[0].center;
const at = (dx: number, dz = 0): Vec3 => ({ x: home.x + dx, y: map[0].groundY, z: home.z + dz });

function director() {
  const d = new SoundDirector();
  d.setMap(map, ME);
  return d;
}
const sounds = (cues: Cue[]) => cues.map((c) => c.sound + (c.kind ? `:${c.kind}` : ''));

describe('falloff math', () => {
  it('inverse distance model: 1 within ref, halves at 2×ref, 0 past max', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(5)).toBe(1);
    expect(distanceGain(10)).toBeCloseTo(0.5);
    expect(distanceGain(120)).toBeCloseTo(5 / 120);
    expect(distanceGain(121)).toBe(0);
  });
  it('air absorption darkens with distance', () => {
    expect(distanceCutoff(5)).toBe(18000);
    expect(distanceCutoff(120)).toBeCloseTo(2000);
    expect(distanceCutoff(60)).toBeLessThan(distanceCutoff(30));
  });
  it('echo only for distant sounds', () => {
    expect(echoSend(10)).toBe(0);
    expect(echoSend(100)).toBeGreaterThan(echoSend(40));
  });
  it('2D cues skip falloff', () => {
    expect(audibility(0.7, null, { x: 0, y: 0, z: 0 })).toBe(0.7);
    expect(audibility(1, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(0.5);
  });
  it('low-health muffle + heartbeat speed', () => {
    expect(muffleCutoff(30)).toBe(20000);
    expect(muffleCutoff(5)).toBeLessThan(muffleCutoff(25));
    expect(muffleCutoff(5, false)).toBe(20000);
    expect(heartbeatInterval(5)).toBeLessThan(heartbeatInterval(29));
  });
  it('waves louder at the shoreline', () => {
    expect(waveLevel(0)).toBeCloseTo(1);
    expect(waveLevel(30)).toBeLessThan(0.3);
  });
});

describe('VoiceLimiter', () => {
  const opts = { maxVoices: 3, perFrame: 2, perFrameByKey: { tick: 1 }, minLevel: 0.05 };
  it('drops cues too quiet to hear', () => {
    const l = new VoiceLimiter(opts);
    expect(l.admit('shot', 0.01, 0, 1)).toEqual({ ok: false, reason: 'quiet' });
  });
  it('caps starts of one sound per frame, resets next frame', () => {
    const l = new VoiceLimiter({ ...opts, maxVoices: 50 });
    expect(l.admit('shot_smg', 1, 0, 1).ok).toBe(true);
    expect(l.admit('shot_smg', 1, 0, 1).ok).toBe(true);
    expect(l.admit('shot_smg', 1, 0, 1)).toEqual({ ok: false, reason: 'frame-cap' });
    expect(l.admit('tick', 1, 0, 1).ok).toBe(true);
    expect(l.admit('tick', 1, 0, 1).ok).toBe(false);
    l.beginFrame();
    expect(l.admit('shot_smg', 1, 0, 1).ok).toBe(true);
  });
  it('when full, a louder cue steals the quietest voice; a quieter one is dropped', () => {
    const l = new VoiceLimiter({ ...opts, perFrame: 10 });
    const a = l.admit('x', 0.5, 0, 5), b = l.admit('x', 0.2, 0, 5), c = l.admit('x', 0.9, 0, 5);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect(l.admit('x', 0.1, 0, 5)).toEqual({ ok: false, reason: 'full' });
    const d = l.admit('x', 0.6, 0, 5);
    expect(d.ok && d.evict).toBe(b.ok && b.id);
    expect(l.count).toBe(3);
  });
  it('voices expire or are released', () => {
    const l = new VoiceLimiter({ ...opts, perFrame: 10 });
    const a = l.admit('x', 1, 0, 1);
    l.admit('x', 1, 0, 1); l.admit('x', 1, 0, 5);
    if (a.ok) l.release(a.id);
    expect(l.count).toBe(2);
    expect(l.admit('x', 0.1, 2, 1).ok).toBe(true); // the 1 s voice expired by t=2
  });
  it('8 SMGs in one frame → capped', () => {
    const l = new VoiceLimiter();
    const ok = Array.from({ length: 8 }, () => l.admit('shot_smg', 0.8, 0, 0.2).ok).filter(Boolean).length;
    expect(ok).toBe(2);
  });
});

describe('SoundDirector: events → cues', () => {
  it('own shot is 2D + own; others positional at muzzle', () => {
    const d = director();
    const from = { x: 1, y: 2, z: 3 };
    const cues = d.update(snap(1, [player(ME, at(0)), player(BOT, at(5))], [
      ['shot', { by: ME, weapon: 'rifle', from, to: from }],
      ['shot', { by: BOT, weapon: 'smg', from, to: from }],
    ]));
    expect(cues[0]).toMatchObject({ sound: 'shot', kind: 'rifle', own: true, pos: null });
    expect(cues[1]).toMatchObject({ sound: 'shot', kind: 'smg', own: false, pos: from });
  });

  it('hits: you got hit → hurt; your hit → impact + hitmarker; others → impact only', () => {
    const d = director();
    const ps = [player(ME, at(0)), player(BOT, at(5)), player(3, at(9))];
    expect(sounds(d.update(snap(1, ps, [['hit', { target: ME, by: BOT, amount: 20 }]])))).toEqual(['hurt']);
    expect(sounds(d.update(snap(1.1, ps, [['hit', { target: BOT, by: ME, amount: 20 }]])))).toEqual(['impact', 'hitmarker']);
    expect(sounds(d.update(snap(1.2, ps, [['hit', { target: 3, by: BOT, amount: 20 }]])))).toEqual(['impact']);
  });

  it('shield hits sound different from flesh; a break shatters', () => {
    const d = director();
    const ps = [player(ME, at(0)), player(BOT, at(5))];
    expect(sounds(d.update(snap(1, ps, [['hit', { target: ME, by: BOT, amount: 20, shieldAmount: 20, broke: false }]])))).toEqual(['shieldHit']);
    expect(sounds(d.update(snap(1.1, ps, [['hit', { target: ME, by: BOT, amount: 30, shieldAmount: 10, broke: true }]])))).toEqual(['shieldHit', 'shieldBreak', 'hurt']);
    expect(sounds(d.update(snap(1.2, ps, [['hit', { target: BOT, by: ME, amount: 20, shieldAmount: 20, broke: false }]])))).toEqual(['shieldHit', 'hitmarker']);
    const cues = d.update(snap(1.3, ps, [['hit', { target: BOT, by: ME, amount: 20, shieldAmount: 5, broke: true }]]));
    expect(sounds(cues)).toEqual(['shieldHit', 'shieldBreak', 'impact', 'hitmarker']);
    expect(cues[1].pos).not.toBeNull();
  });

  it('drinking: gulp when anyone starts, a chime when your potion is done', () => {
    const d = director();
    d.update(snap(1, [player(ME, at(0)), player(BOT, at(5))]));
    const drinking = { kind: 'shieldBig' as const, doneAt: 3 };
    let cues = d.update(snap(1.1, [player(ME, at(0), { drinking }), player(BOT, at(5), { drinking })]));
    expect(sounds(cues)).toEqual(['drink', 'drink']);
    expect(cues[0].pos).toBeNull();
    expect(cues[1].pos).not.toBeNull();
    cues = d.update(snap(3.1, [player(ME, at(0), { shield: 50 }), player(BOT, at(5))]));
    expect(sounds(cues)).toEqual(['potionDone:shieldBig']);
    // Dying mid-drink: no chime.
    d.update(snap(4, [player(ME, at(0), { drinking })]));
    expect(sounds(d.update(snap(4.1, [player(ME, at(0), { alive: false })])))).toEqual([]);
  });

  it('kill / death / water splash', () => {
    const d = director();
    const ps = [player(ME, at(0)), player(BOT, at(5))];
    expect(sounds(d.update(snap(1, ps, [['kill', { victim: BOT, killer: ME, inWater: false }]])))).toEqual(['kill']);
    expect(sounds(d.update(snap(2, ps, [['kill', { victim: ME, killer: BOT, inWater: true }]])))).toEqual(['death', 'splash']);
  });

  it('every seal booms for everyone, alarm only for YOUR island; stingers for win/lose/draw/eliminated; horn; escape', () => {
    const d = director();
    const ps = [player(ME, at(0)), player(BOT, at(5))];
    expect(sounds(d.update(snap(1, ps, [['sealed', { island: 1 }]])))).toEqual(['explosion:charge']);
    expect(sounds(d.update(snap(1.1, ps, [['sealed', { island: 0 }]])))).toEqual(['explosion:charge', 'alarm']);
    expect(sounds(d.update(snap(1.2, ps, [['eliminated', { player: ME }], ['eliminated', { player: BOT }]])))).toEqual(['eliminated']);
    expect(sounds(d.update(snap(1.3, ps, [['win', { winner: ME }]])))).toEqual(['win']);
    expect(sounds(d.update(snap(1.4, ps, [['win', { winner: BOT }]])))).toEqual(['lose']);
    expect(sounds(d.update(snap(1.5, ps, [['win', { winner: -1 }]])))).toEqual(['draw']);
    expect(sounds(d.update(snap(1.6, ps, [['suddenDeath', {}]])))).toEqual(['horn']);
    expect(sounds(d.update(snap(1.7, ps, [['escaped', { player: BOT }], ['escaped', { player: ME }]])))).toEqual(['escaped']);
  });

  it('lightning → thunder at the strike; sudden death turns on the storm ambience', () => {
    const d = director();
    const ps = [player(ME, at(0))];
    expect(d.update(snap(1, ps, [['lightning', { pos: { x: 30, y: 2, z: 5 } }]]))).toEqual([{ sound: 'thunder', pos: { x: 30, y: 2, z: 5 }, gain: 1.2 }]);
    expect(d.env.storm).toBe(false);
    d.update({ ...snap(1.1, ps, []), suddenDeath: true });
    expect(d.env.storm).toBe(true);
  });

  it('explosion, placed (by piece kind), destroyed (position from previous snapshot)', () => {
    const d = director();
    const ps = [player(ME, at(0))];
    const piece: PieceState = { id: 7, kind: 'steel', owner: ME, pos: at(2), rotY: 0, hp: 100 };
    const c1 = d.update(snap(1, ps, [['explosion', { kind: 'grenade', pos: at(3), by: ME }], ['placed', { piece: 7, kind: 'steel', by: ME }]], { pieces: [piece] }));
    expect(sounds(c1)).toEqual(['explosion:grenade', 'placed:steel']);
    expect(c1[1].pos).toEqual(piece.pos);
    const c2 = d.update(snap(1.1, ps, [['destroyed', { piece: 7, kind: 'steel' }]]));
    expect(sounds(c2)).toEqual(['destroyed:steel']);
    expect(c2[0].pos!.x).toBe(piece.pos.x);
  });

  it('cash: rise → coin; rise with a loot bag at your feet vanishing → loot; spend → purchase; deposit → silent', () => {
    const d = director();
    const cash = (c: number, vault = 0) => player(ME, at(0), { inv: { ...emptyInventory(), cash: c }, vault: { ...emptyInventory(), cash: vault } });
    d.update(snap(1, [cash(50)]));
    expect(sounds(d.update(snap(1.1, [cash(80)])))).toEqual(['coin']);
    d.update(snap(1.2, [cash(80)], [], { loot: [{ id: 3, pos: at(1), inv: emptyInventory() }] }));
    expect(sounds(d.update(snap(1.3, [cash(120)])))).toEqual(['loot']);
    expect(sounds(d.update(snap(1.4, [cash(70)])))).toEqual(['purchase']);
    expect(sounds(d.update(snap(1.5, [cash(20, 50)])))).toEqual([]);
  });

  it('no coin when cash comes back on respawn', () => {
    const d = director();
    d.update(snap(1, [player(ME, at(0), { alive: false, inv: emptyInventory() })]));
    expect(sounds(d.update(snap(2, [player(ME, at(0))])))).toEqual([]);
  });

  it('trapped countdown beeps once per second, urgent in last 3', () => {
    const d = director();
    const trapped = (t: number) => d.update(snap(t, [player(ME, at(0), { breakoutUntil: 10 })]));
    const out: string[] = [];
    for (let t = 0; t < 10; t += 1 / 30) out.push(...sounds(trapped(t)));
    expect(out.length).toBe(10);
    expect(out.filter((s) => s === 'tick:urgent').length).toBe(3);
    expect(sounds(d.update(snap(10.1, [player(ME, at(0))])))).toEqual([]);
  });

  it('footsteps every stride on the ground, none airborne or on teleport', () => {
    const d = director();
    let n = 0;
    for (let i = 0; i <= 30; i++) n += d.update(snap(i / 30, [player(ME, at(i * 0.15))])).filter((c) => c.sound === 'footstep').length; // 4.5 m/s for 1 s
    expect(n).toBe(2); // 4.5 m / 1.7 m stride
    let air = 0;
    for (let i = 31; i <= 60; i++) air += d.update(snap(i / 30, [player(ME, at(i * 0.15), { vel: { x: 0, y: 3, z: 0 } })])).length;
    expect(air).toBe(0);
    expect(d.update(snap(2.1, [player(ME, at(-15))])).length).toBe(0); // teleport
  });

  it('env: low hp, bunker, shoreline', () => {
    const d = director();
    d.update(snap(1, [player(ME, map[0].bunker.center, { hp: 20 })]));
    expect(d.env).toMatchObject({ alive: true, hp: 20, inBunker: true });
    d.update(snap(2, [player(ME, at(map[0].radius - 1))]));
    expect(d.env.inBunker).toBe(false);
    expect(d.env.shoreDist).toBeCloseTo(1);
  });
});

describe('surfaces', () => {
  it('island ground: grass inland, sand near shore, concrete in the bunker', () => {
    expect(surfaceAt(at(map[0].radius - 2), [], map)).toBe('sand');
    expect(surfaceAt(map[0].bunker.center, [], map)).toBe('concrete');
    expect(shoreDistance(at(0), map)).toBeCloseTo(map[0].radius);
  });
  it('standing on a piece: its material (rotated footprint)', () => {
    const p0 = at(10, 10);
    const scaffold: PieceState = { id: 1, kind: 'scaffold', owner: ME, pos: { ...p0, y: p0.y + 1 }, rotY: Math.PI / 2, hp: 1 };
    // Scaffold is 2 wide × 4 deep; rotated 90° the 4 m extends along world X.
    expect(surfaceAt({ x: p0.x + 1.8, y: p0.y + 1.2, z: p0.z }, [scaffold], map)).toBe('hollow');
    expect(surfaceAt({ x: p0.x, y: p0.y + 1.2, z: p0.z + 1.8 }, [scaffold], map)).not.toBe('hollow');
    expect(pieceSurface('container')).toBe('metal');
    expect(pieceSurface('wood')).toBe('wood');
  });
});

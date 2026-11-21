import { describe, expect, test } from 'vitest';
import { BuyQueue, BUY_PACE_MS, ammoWarning, slotAmmoState } from '../../src/client/qol/combatQol';
import { barX, headingDeg, relAngle, yawToward } from '../../src/client/qol/compassMath';
import { inviteLink, joinCodeFrom } from '../../src/client/qol/invite';
import { loadPrefs, savePrefs, sanitizePrefs, seatPrefsOf } from '../../src/client/qol/prefs';
import { RecapTracker, sourceOf } from '../../src/client/qol/recap';
import { clearRejoin, loadRejoin, markAutoRejoin, REJOIN_GRACE_MS, saveRejoin, takeAutoRejoin, touchRejoin } from '../../src/client/qol/rejoin';
import { awards, fmtLife, summaryOrder } from '../../src/client/qol/summaryData';
import { newPlayer } from '../../src/sim/player';
import type { MatchEvent, PlayerStats, Snapshot } from '../../src/sim/types';
import { forward, v3 } from '../../src/sim/vec';

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('invite links', () => {
  test('origin + ?join=CODE, keeping dev transport flags', () => {
    expect(inviteLink('K7Q2MX', { origin: 'https://faefight.vercel.app', pathname: '/', search: '' })).toBe('https://faefight.vercel.app/?join=K7Q2MX');
    expect(inviteLink('K7Q2MX', { origin: 'http://localhost:5173', pathname: '/', search: '?net=local&debug=1&join=AAAAAA' }))
      .toBe('http://localhost:5173/?net=local&debug=1&join=K7Q2MX');
  });
  test('reads and normalizes ?join=', () => {
    expect(joinCodeFrom('?join=k7q2mx')).toBe('K7Q2MX');
    expect(joinCodeFrom('?join=nope')).toBeNull();
    expect(joinCodeFrom('?debug=1')).toBeNull();
  });
});

describe('rejoin record', () => {
  test('fresh within the grace window, gone after; cleared on purpose', () => {
    const kv = memStore();
    saveRejoin({ code: 'K7Q2MX', token: 'abcdef12-3456', name: 'Bob' }, 1000, kv);
    expect(loadRejoin(1000 + REJOIN_GRACE_MS - 1, kv)?.code).toBe('K7Q2MX');
    touchRejoin(15_000, kv);
    expect(loadRejoin(30_000, kv)?.token).toBe('abcdef12-3456');
    expect(loadRejoin(15_000 + REJOIN_GRACE_MS, kv)).toBeNull();
    saveRejoin({ code: 'K7Q2MX', token: 'abcdef12-3456', name: 'Bob' }, 0, kv);
    markAutoRejoin(kv);
    clearRejoin(kv);
    expect(loadRejoin(1, kv)).toBeNull();
    expect(takeAutoRejoin(kv)).toBe(false);
  });
  test('rejects malformed tokens', () => {
    const kv = memStore();
    saveRejoin({ code: 'K7Q2MX', token: '<script>', name: 'Bob' }, 0, kv);
    expect(loadRejoin(1, kv)).toBeNull();
  });
  test('auto flag is taken once', () => {
    const kv = memStore();
    markAutoRejoin(kv);
    expect(takeAutoRejoin(kv)).toBe(true);
    expect(takeAutoRejoin(kv)).toBe(false);
  });
});

describe('prefs', () => {
  test('round trip and sanitize', () => {
    const kv = memStore();
    expect(loadPrefs(kv)).toEqual({ difficulty: 'medium', bots: 1, map: null, seats: null, lastBuy: null });
    savePrefs({ difficulty: 'pro', bots: 4 }, kv);
    savePrefs({ seats: [{ kind: 'bot', difficulty: 'hard' }, { kind: 'open' }], lastBuy: 'steel' }, kv);
    expect(loadPrefs(kv)).toMatchObject({ difficulty: 'pro', bots: 4, seats: [{ kind: 'bot', difficulty: 'hard' }, { kind: 'open' }], lastBuy: 'steel' });
    expect(sanitizePrefs({ difficulty: 'godlike', bots: 99, seats: [{ kind: 'human' }] })).toMatchObject({ difficulty: 'medium', bots: 7, seats: null });
  });
  test('lobby seats → prefs (friends remembered as open seats)', () => {
    expect(seatPrefsOf([
      { kind: 'human', name: 'A', peerId: 'h', isHost: true },
      { kind: 'human', name: 'B', peerId: 'x', isHost: false },
      { kind: 'bot', difficulty: 'easy', name: 'Zed' },
    ])).toEqual([{ kind: 'open' }, { kind: 'bot', difficulty: 'easy' }]);
  });
});

describe('combat QoL', () => {
  test('ammo warnings', () => {
    expect(ammoWarning(30, 60, 30, false)).toBeNull();
    expect(ammoWarning(7, 60, 30, false)?.kind).toBe('low');
    expect(ammoWarning(7, 0, 30, false)?.kind).toBe('last');
    expect(ammoWarning(0, 0, 30, false)?.kind).toBe('empty');
    expect(ammoWarning(0, 30, 30, true)).toBeNull();
    expect(ammoWarning(1, 0, 1, false)).toBeNull(); // rocket launcher: one round is normal
    expect(ammoWarning(0, 0, 1, false)?.kind).toBe('empty');
    expect(slotAmmoState(3, 0)).toBe('nospare');
    expect(slotAmmoState(0, 0)).toBe('empty');
    expect(slotAmmoState(3, 9)).toBeNull();
  });
  test('buy queue releases one buy per pace', () => {
    const q = new BuyQueue();
    q.add('wood', 3);
    expect(q.take(0)).toBe('wood');
    expect(q.take(BUY_PACE_MS - 1)).toBeNull();
    expect(q.take(BUY_PACE_MS)).toBe('wood');
    expect(q.take(BUY_PACE_MS * 2)).toBe('wood');
    expect(q.take(BUY_PACE_MS * 3)).toBeNull();
  });
});

describe('compass', () => {
  test('bearings follow the sim yaw convention', () => {
    const o = { x: 0, z: 0 };
    for (const yaw of [0, 1, -2, 3]) {
      const f = forward(yaw);
      expect(relAngle(yawToward(o, { x: f.x, z: f.z }), yaw)).toBeCloseTo(0);
    }
    // Facing north (-z): east (+x) is 90° to the right.
    expect(relAngle(yawToward(o, { x: 10, z: 0 }), 0)).toBeCloseTo(Math.PI / 2);
    expect(relAngle(yawToward(o, { x: -10, z: 0 }), 0)).toBeCloseTo(-Math.PI / 2);
    expect(headingDeg(0)).toBe(0);
    expect(headingDeg(-Math.PI / 2)).toBe(90);
    expect(headingDeg(Math.PI / 2)).toBe(270);
    expect(barX(Math.PI / 4, Math.PI / 2, 200)).toBeCloseTo(100);
    expect(barX(Math.PI, Math.PI / 2, 200)).toBeNull();
  });
});

describe('death recap', () => {
  const snap = (time: number, events: MatchEvent[], patch: (s: Snapshot) => void = () => {}): Snapshot => {
    const me = newPlayer(1, 'Me', false, 0, v3(0, 0, 0));
    const rex = newPlayer(2, 'Rex', true, 1, v3(30, 0, 40));
    rex.hp = 64; rex.shield = 25; rex.equipped = 'rifle';
    const s = { time, tick: 0, players: [me, rex], pieces: [], loot: [], generators: [], genLevels: [], sealed: [], waterY: -5, suddenDeath: false, winner: null, events } as Snapshot;
    patch(s);
    return s;
  };
  const hit = (t: number, data: Record<string, unknown>): MatchEvent => ({ t, type: 'hit', data: { target: 1, ...data } });

  test('killer, weapon, distance, headshot, damage by source in the last 10 s, killer HP', () => {
    const r = new RecapTracker();
    expect(r.onSnapshot(snap(1, [hit(1, { by: null, amount: 15, weapon: 'fall' })]), 1)).toBeNull(); // > 10 s before death: dropped
    r.onSnapshot(snap(12, [hit(12, { by: 2, amount: 40, weapon: 'grenade' })]), 1);
    r.onSnapshot(snap(13, [hit(13, { by: 2, amount: 30, weapon: 'rifle', part: 'body' })]), 1);
    const recap = r.onSnapshot(snap(14, [
      hit(14, { by: 2, amount: 60, weapon: 'rifle', part: 'head' }),
      { t: 14, type: 'kill', data: { victim: 1, killer: 2, inWater: false } },
    ], (s) => { s.players[0].alive = false; s.players[0].pos = v3(0, -1000, 0); }), 1)!;
    expect(recap.title).toBe('Killed by Rex');
    expect(recap.killer?.name).toBe('Rex');
    expect(recap.weapon).toBe('rifle');
    expect(recap.headshot).toBe(true);
    expect(recap.distance).toBe(50); // from where I last stood alive, not the parked corpse
    expect(recap.bySource).toEqual([{ source: 'bullets', amount: 90 }, { source: 'explosion', amount: 40 }]);
    expect([recap.killerHp, recap.killerShield]).toEqual([64, 25]);
  });

  test('drowning and falling', () => {
    const r = new RecapTracker();
    const w = r.onSnapshot(snap(5, [{ t: 5, type: 'kill', data: { victim: 1, killer: null, inWater: true } }]), 1)!;
    expect(w.title).toBe('You drowned');
    expect(w.weapon).toBe('water');
    expect(w.bySource[0].source).toBe('water');
    const f = r.onSnapshot(snap(9, [hit(9, { by: null, amount: 120, weapon: 'fall' }), { t: 9, type: 'kill', data: { victim: 1, killer: null } }]), 1)!;
    expect(f.title).toBe('You fell to your death');
    expect(f.bySource).toEqual([{ source: 'fall', amount: 120 }]);
    expect(sourceOf(undefined, 3)).toBe('explosion'); // old grenade hits carried no weapon
  });
});

describe('match summary', () => {
  const st = (id: number, p: Partial<PlayerStats>): PlayerStats => ({ id, kills: 0, deaths: 0, damage: 0, seals: 0, built: 0, cash: 0, longestLife: 0, headshots: 0, ...p });
  test('awards go to the best at each, nobody wins an award for zero', () => {
    const stats = [st(1, { kills: 3, damage: 420, built: 4 }), st(2, { kills: 1, damage: 300, built: 22, seals: 2, headshots: 5 }), st(3, {})];
    const a = awards(stats);
    expect(a.map((x) => [x.key, x.id])).toEqual([['mvp', 1], ['builder', 2], ['sealer', 2], ['sharpshooter', 2]]);
    expect(awards([st(1, {}), st(2, {})])).toEqual([]);
    expect(summaryOrder(stats).map((s) => s.id)).toEqual([1, 2, 3]);
    expect(fmtLife(83.4)).toBe('1:23');
  });
});

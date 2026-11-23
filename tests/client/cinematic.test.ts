import { describe, expect, it } from 'vitest';
import { InterestTracker, type InterestPlayer, type InterestSnap } from '../../src/client/cinematic/interest';
import { CUT, Director, type ShotEvent } from '../../src/client/cinematic/director';

const pl = (id: number, o: Partial<InterestPlayer> = {}): InterestPlayer => ({
  id, name: `P${id}`, alive: true, eliminated: false, island: id - 1, pos: { x: id * 10, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
  hp: 100, shield: 0, kills: 0, ...o,
});
let tick = 0;
const snap = (time: number, players: InterestPlayer[], o: Partial<InterestSnap> = {}): InterestSnap => ({
  time, tick: ++tick, players, sealed: players.map(() => false), suddenDeath: false, events: [], ...o,
});
const hit = (t: number, by: number, target: number) => ({ t, type: 'hit', data: { by, target, amount: 20 } });

describe('cinematic interest scoring', () => {
  it('a duel about to end beats a quiet player, and features the side in more danger', () => {
    const tr = new InterestTracker();
    const ps = [pl(1, { hp: 15 }), pl(2, { hp: 60 }), pl(3)];
    tr.ingest(snap(10, ps, { events: [hit(9.8, 1, 2), hit(9.9, 2, 1)] }));
    const top = tr.storylines(snap(10, ps))[0];
    expect(top.playerId).toBe(1);
    expect(['duel', 'clutch']).toContain(top.reason);
    // Low HP raises the duel score.
    const tr2 = new InterestTracker();
    const healthy = [pl(1, { hp: 90 }), pl(2, { hp: 95 })];
    tr2.ingest(snap(10, healthy, { events: [hit(9.8, 1, 2), hit(9.9, 2, 1)] }));
    const duelHealthy = tr2.storylines(snap(10, healthy)).find((l) => l.reason === 'duel')!.score;
    const duelLow = tr.storylines(snap(10, ps)).find((l) => l.reason === 'duel')!.score;
    expect(duelLow).toBeGreaterThan(duelHealthy);
  });

  it('an elimination is the top story and orbits where the victim fell, featuring the killer', () => {
    const tr = new InterestTracker();
    const ps = [pl(1), pl(2), pl(3, { kills: 2 })];
    tr.ingest(snap(5, ps));
    const after = [pl(1), pl(2, { alive: false, eliminated: true }), pl(3, { kills: 2 })];
    tr.ingest(snap(6, after, { events: [{ t: 6, type: 'kill', data: { victim: 2, killer: 1 } }, { t: 6, type: 'eliminated', data: { player: 2 } }] }));
    const top = tr.storylines(snap(6.2, after))[0];
    expect(top).toMatchObject({ reason: 'elimination', playerId: 1, otherId: 2, kind: 'orbit' });
    expect(top.at).toEqual({ x: 20, y: 0, z: 0 });
    // It fades out after a few seconds.
    tr.ingest(snap(20, after));
    expect(tr.storylines(snap(20, after))[0].reason).not.toBe('elimination');
  });

  it('a sealed player being hunted, a rocket incoming and sudden death all register', () => {
    const tr = new InterestTracker();
    const ps = [pl(1), pl(2), pl(3)];
    const s = snap(30, ps, {
      sealed: [false, true, false],
      brains: [{ id: 1, goal: 'attack', target: 2 }, { id: 3, goal: 'fight', target: 2 }],
      projectiles: [{ kind: 'rocket', pos: { x: 0, y: 1, z: 0 }, vel: { x: 30, y: 0, z: 0 } }],
    });
    tr.ingest(s);
    const lines = tr.storylines(s);
    expect(lines.find((l) => l.reason === 'hunt')?.playerId).toBe(2);
    expect(lines.find((l) => l.reason === 'rocket')?.playerId).toBe(1); // first in the rocket's path
    const sd = snap(31, ps, { suddenDeath: true, storm: { x: 5, z: 5 } });
    tr.ingest(sd);
    expect(tr.storylines(sd).find((l) => l.reason === 'suddenDeath')).toMatchObject({ kind: 'drone', at: { x: 5, z: 5 } });
  });

  it('the dead are never featured (except an orbit on where they fell)', () => {
    const tr = new InterestTracker();
    const ps = [pl(1, { alive: false }), pl(2)];
    tr.ingest(snap(1, ps));
    for (const l of tr.storylines(snap(1, ps))) if (l.kind !== 'orbit') expect(l.playerId).toBe(2);
  });
});

describe('cinematic director hysteresis', () => {
  const run = (d: Director, from: number, to: number, mk: (t: number) => InterestSnap) => {
    for (let t = from; t <= to + 1e-9; t += 1 / 30) d.update(mk(t));
  };

  it('opens on a wide establishing shot, then holds each shot at least the minimum length', () => {
    const d = new Director();
    const shots: ShotEvent[] = [];
    d.on('shot', (e) => shots.push(e));
    d.setActive(true);
    // Two players whose interest flips back and forth every second: the director must not ping-pong.
    const mk = (t: number) => {
      const a = Math.floor(t) % 2 === 0;
      return snap(t, [pl(1, { kills: a ? 3 : 0 }), pl(2, { kills: a ? 0 : 3 })]);
    };
    run(d, 0, 60, mk);
    expect(shots[0].kind).toBe('wide');
    for (let i = 2; i < shots.length; i++) expect(shots[i].t - shots[i - 1].t).toBeGreaterThanOrEqual(CUT.minShot - 0.2);
    // ...but still cuts regularly (max shot length).
    expect(shots.length).toBeGreaterThanOrEqual(Math.floor(60 / CUT.maxShot));
    expect(shots.length).toBeLessThanOrEqual(Math.ceil(60 / CUT.minShot) + 1);
  });

  it('a big moment (elimination) interrupts a shot early; a small change does not', () => {
    const d = new Director();
    const shots: ShotEvent[] = [];
    d.on('shot', (e) => shots.push(e));
    d.setActive(true);
    const quiet = (t: number) => snap(t, [pl(1, { kills: 1 }), pl(2), pl(3)]);
    run(d, 0, 6, quiet); // past the opening
    const n = shots.length;
    const startT = shots[n - 1].t;
    run(d, 6 + 1 / 30, startT + 2, quiet);
    expect(shots.length).toBe(n);
    // Player 3 is eliminated by player 2.
    const t0 = startT + 2.1;
    d.update(snap(t0, [pl(1, { kills: 1 }), pl(2, { kills: 1 }), pl(3, { alive: false, eliminated: true })],
      { events: [{ t: t0, type: 'kill', data: { victim: 3, killer: 2 } }, { t: t0, type: 'eliminated', data: { player: 3 } }] }));
    run(d, t0 + 0.2, t0 + 0.5, (t) => snap(t, [pl(1, { kills: 1 }), pl(2, { kills: 1 }), pl(3, { alive: false, eliminated: true })]));
    const last = shots[shots.length - 1];
    expect(last).toMatchObject({ reason: 'elimination', playerId: 2, kind: 'orbit' });
    expect(last.t - startT).toBeLessThan(CUT.minShot);
  });

  it('summary lists the featured player and top storylines; active events fire', () => {
    const d = new Director();
    const act: boolean[] = [];
    const off = d.on('active', (a) => act.push(a));
    d.setActive(true);
    d.update(snap(1, [pl(1, { hp: 10 }), pl(2)], { events: [hit(0.9, 2, 1), hit(0.95, 1, 2)] }));
    const s = d.summary();
    expect(s.featured).not.toBeNull();
    expect(s.alive).toBe(2);
    expect(s.storylines.length).toBeGreaterThan(0);
    expect(s.storylines.length).toBeLessThanOrEqual(3);
    d.setActive(false);
    off();
    d.setActive(true);
    expect(act).toEqual([true, false]);
    expect(d.update(snap(2, [pl(1)]))).not.toBeNull();
  });
});

describe('cinematic director quiet moments', () => {
  it('rotates through players when nothing is happening', () => {
    const d = new Director();
    const seen = new Set<number>(), kinds = new Set<string>();
    d.on('shot', (e) => { seen.add(e.playerId); if (e.t > CUT.opening) kinds.add(e.kind); });
    d.setActive(true);
    for (let t = 0; t <= 120; t += 1 / 30) d.update(snap(t, [pl(1), pl(2), pl(3), pl(4)]));
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect([...kinds].sort()).toEqual(['shoulder', 'wide']); // and the angle keeps changing
  });
});

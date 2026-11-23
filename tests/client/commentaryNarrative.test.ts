import { describe, expect, it } from 'vitest';
import { Narrative, type NarrativeHost } from '../../src/client/cinematic/commentary/narrative';
import { fill, LINES, type LineKey, type Vars } from '../../src/client/cinematic/commentary/lines';
import { LIFECYCLE } from '../../src/sim/constants';
import type { BotBrainInfo, PlayerState, Snapshot } from '../../src/sim/types';

const NAMES = ['Ava', 'Bruno', 'Cleo', 'Dax'];
const player = (id: number, over: Partial<PlayerState> = {}): PlayerState => ({
  id, name: NAMES[id - 1], isBot: true, island: id - 1, pos: { x: 0, y: 0, z: 0 }, hp: 100, shield: 0, alive: true, eliminated: false,
  kills: 0, deaths: 0, breakoutUntil: null, drinking: null, inv: { cash: 0, medkits: 0, potions: {} },
  ...over,
}) as unknown as PlayerState;
const snap = (t: number, players = NAMES.map((_, i) => player(i + 1)), over: Partial<Snapshot> = {}): Snapshot => ({
  time: t, players, sealed: players.map(() => false), suddenDeath: false, winner: null, events: [], pieces: [], genLevels: [], ...over,
}) as unknown as Snapshot;
const brain = (id: number, goal: string, target: number | null = null): BotBrainInfo =>
  ({ id, personality: 'rusher', difficulty: 'hard', action: '', goal, reason: '', steps: [], step: 0, fightOdds: null, thought: '', target, options: [] });

function rig() {
  const said: { key: LineKey; vars: Vars; text: string }[] = [];
  const cool = new Map<string, number>();
  let t = 0;
  const host: NarrativeHost & { unready(tag: string): void } = {
    say: (key, vars) => said.push({ key, vars, text: fill(LINES[key][0], vars) }),
    name: (id) => NAMES[id - 1] ?? `P${id}`,
    ready: (tag, sec) => { const at = cool.get(tag); if (at !== undefined && t - at < sec) return false; cool.set(tag, t); return true; },
    unready: (tag) => cool.delete(tag),
    rng: () => 0.1,
  };
  const n = new Narrative(host);
  return { n, said, keys: () => said.map((s) => s.key), tick: (s: number) => { t += s; } };
}

describe('storyline memory', () => {
  it('detects a rivalry and calls back to it with the head-to-head record', () => {
    const r = rig();
    r.n.onSnapshot(snap(10));
    r.n.onKill(1, 2, 10); r.tick(30);
    r.n.onKill(2, 1, 40); r.tick(30);
    expect(r.keys()).not.toContain('callbackRivalry');
    r.n.onKill(1, 2, 70);
    const cb = r.said.find((s) => s.key === 'callbackRivalry')!;
    expect(cb.vars).toMatchObject({ a: 'Ava', b: 'Bruno', n: 3, g: 2 });
    expect(cb.text).toMatch(/meeting number 3 between Ava and Bruno, and Ava has won 2/);
  });

  it('remembers a repeat seal by the same player', () => {
    const r = rig();
    r.n.onSealed(3, 2, 100);
    expect(r.keys()).toEqual([]);
    r.n.onSealed(3, 2, 220);
    expect(r.said[0]).toMatchObject({ key: 'callbackSeal', vars: { a: 'Cleo', b: 'Bruno', w: 'two minutes ago' } });
  });

  it('tracks streaks and calls the one that ends them', () => {
    const r = rig();
    r.n.onSnapshot(snap(1));
    for (let v = 2; v <= 4; v++) { r.tick(100); r.n.onKill(1, v, v * 10); }
    expect(r.said.find((s) => s.key === 'streak')?.vars).toMatchObject({ a: 'Ava', n: 3 });
    r.tick(100);
    r.n.onKill(4, 1, 100);
    expect(r.said.at(-1)).toMatchObject({ key: 'streakEnd', vars: { a: 'Dax', b: 'Ava', n: 3 } });
  });

  it('recalls an escape or a clutch when that player is finally eliminated', () => {
    const r = rig();
    r.n.onEscaped(2);
    r.n.onEliminated(2);
    r.n.onKill(3, 1, 5, { clutchHp: 6 });
    r.n.onEliminated(3);
    expect(r.keys()).toContain('callbackNearElim');
    expect(r.said.find((s) => s.key === 'callbackClutch')?.vars).toMatchObject({ a: 'Cleo', n: 6 });
  });

  it('explains a third-party kill', () => {
    const r = rig();
    r.n.onSnapshot(snap(50));
    r.n.onHit(2, 3, 48);
    r.n.onKill(1, 2, 50);
    expect(r.said.at(-1)).toMatchObject({ key: 'whyThirdParty', vars: { a: 'Ava', b: 'Bruno' } });
  });

  it('gives a halftime recap with the rivalry of the match', () => {
    const r = rig();
    const ps = NAMES.map((_, i) => player(i + 1, { kills: [5, 2, 1, 0][i] }));
    r.n.onKill(1, 2, 10); r.tick(100); r.n.onKill(1, 2, 20); r.tick(100); r.n.onKill(2, 1, 30);
    r.n.onSnapshot(snap(LIFECYCLE.suddenDeathAt / 2 + 1, ps));
    expect(r.keys()).toContain('halftime');
    expect(r.said.find((s) => s.key === 'halftime')?.vars).toMatchObject({ a: 'Ava', n: 5 });
    expect(r.said.find((s) => s.key === 'recapRivalry')?.vars).toMatchObject({ a: 'Ava', b: 'Bruno', n: 3 });
  });
});

describe('strategy and prediction', () => {
  it('turns brain goals into predictions', () => {
    const r = rig();
    const ps = NAMES.map((_, i) => player(i + 1, { inv: { cash: 450, medkits: 0, potions: {} } as never }));
    const s = snap(100, ps);
    const p = ps[0];
    expect(r.n.prediction(p, brain(1, 'seal', 3), s)).toMatchObject({ key: 'predictSeal', vars: { a: 'Ava', b: 'Cleo' } });
    expect(r.n.prediction(p, brain(1, 'attack', 2), s)).toMatchObject({ key: 'predictAttack', vars: { b: 'Bruno' } });
    expect(r.n.prediction(p, brain(1, 'shop'), s)).toMatchObject({ key: 'predictShop', vars: { n: 450 } });
    expect(r.n.prediction(p, brain(1, 'bank'), s)).toMatchObject({ key: 'predictBank' });
    expect(r.n.prediction(p, brain(1, 'bridge'), s)?.key).toBe('predictBridge');
    expect(r.n.prediction(p, brain(1, 'fortify'), s)?.key).toBe('predictDefend');
    expect(r.n.prediction(p, brain(1, 'contest'), s)?.key).toBe('predictContest');
    expect(r.n.prediction({ ...p, hp: 30 }, brain(1, 'disengage'), s)).toMatchObject({ key: 'predictDisengage', vars: { n: 30 } });
    // The quiet-moment path speaks it (the featured player first).
    r.n.onSnapshot({ ...s, brains: [brain(2, 'seal', 4)] });
    r.n.featured = 2;
    expect(r.n.quiet()).toBe(true);
    expect(r.said.at(-1)).toMatchObject({ key: 'predictSeal', vars: { a: 'Bruno', b: 'Dax' } });
  });

  it('never contradicts the state', () => {
    const r = rig();
    const ps = NAMES.map((_, i) => player(i + 1));
    ps[2] = player(3, { eliminated: true, alive: false });
    const s = snap(100, ps, { sealed: [false, false, false, true] });
    // No seal on an eliminated player, nor on an already-sealed bunker; no attack on someone who's out.
    expect(r.n.prediction(ps[0], brain(1, 'seal', 3), s)).toBeNull();
    expect(r.n.prediction(ps[0], brain(1, 'seal', 4), s)).toBeNull();
    expect(r.n.prediction(ps[0], brain(1, 'attack', 3), s)).toBeNull();
    // An eliminated player predicts nothing; a healthy one isn't "backing off on low health"; poor players don't "go shopping big".
    expect(r.n.prediction(ps[2], brain(3, 'attack', 1), s)).toBeNull();
    expect(r.n.prediction(ps[0], brain(1, 'disengage'), s)).toBeNull();
    expect(r.n.prediction(ps[0], brain(1, 'shop'), s)).toBeNull();
    // Defending a bunker that's already sealed isn't a thing.
    expect(r.n.prediction(ps[3], brain(4, 'defend'), s)).toBeNull();
  });

  it('reads plain state for humans: last life, low with no heals (not when holding a potion)', () => {
    const r = rig();
    const ps = [
      player(1, { isBot: false, hp: 20, inv: { cash: 0, medkits: 0, potions: { healPotion: 1 } } as never }),
      player(2, { hp: 18 }),
      player(3, { eliminated: true, alive: false }),
      player(4),
    ];
    r.n.onSnapshot(snap(100, ps, { sealed: [false, false, true, true] }));
    for (let i = 0; i < 4; i++) { r.n.situation(r.n['snap']!); r.tick(1); }
    const low = r.said.filter((s) => s.key === 'adviceLowNoHeal').map((s) => s.vars.a);
    expect(low).toEqual(['Bruno']);
    const last = r.said.filter((s) => s.key === 'oneLifeLeft').map((s) => s.vars.a);
    expect(last).toEqual(['Dax']); // Cleo's island is sealed too, but Cleo is already out
  });
});

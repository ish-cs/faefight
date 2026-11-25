import { test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { withParams, DEFAULT_BOT_PARAMS } from '../../src/sim/bots/params';
import { Match } from '../../src/sim/match';
import type { Difficulty } from '../../src/sim/types';

const SEED = Number(process.env.DIAG_SEED ?? '3');
const OVER: Record<string, number> = JSON.parse(process.env.DIAG_PARAMS || '{}');
test('diag build variant', async () => {
  if (process.env.DIAG_MODE === 'hit') return;
  const P = Object.keys(OVER).length ? withParams(OVER) : DEFAULT_BOT_PARAMS;
  const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'];
  const bots = new Map<number, Bot>();
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed: SEED },
    { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng, undefined, P); bots.set(id, b); return b; } });
  let snap = m.tick(new Map());
  const per = new Map<number, Record<string, number>>();
  for (let i = 0; i < 25 * 60 * 30 && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) if (e.type === 'placed' && e.data.kind !== 'scaffold') {
      const by = e.data.by as number; const g = String((bots.get(by) as any)?.goal);
      const r = per.get(by) ?? {}; r[g] = (r[g] ?? 0) + 1; r.all = (r.all ?? 0) + 1; per.set(by, r);
    }
  }
  const by: Record<string, number> = {};
  for (const [id, b] of bots) by[b.difficulty] = (by[b.difficulty] ?? 0) + (per.get(id)?.all ?? 0);
  console.log(`RESULT variant=${process.env.DIAG_NAME} seed=${SEED} winner=${snap.winner} ${JSON.stringify(by)} pro-goals=${JSON.stringify([1, 5].map((id) => per.get(id) ?? {}))}`);
}, 3_600_000);

test('diag hit variant', async () => {
  if (process.env.DIAG_MODE !== 'hit') return;
  const P = Object.keys(OVER).length ? withParams(OVER) : DEFAULT_BOT_PARAMS;
  const D: Difficulty[] = ['pro', 'hard', 'medium', 'easy'];
  const m = await Match.create({ players: D.map((d) => ({ name: '', isBot: true, difficulty: d })), seed: SEED },
    { makeBot: (id, d, rng) => new Bot(id, d, rng, undefined, P) });
  let snap = m.tick(new Map());
  const skill = new Map(snap.players.map((p, i) => [p.id, D[i]]));
  const shots: Record<string, number> = {}, hits: Record<string, number> = {};
  for (let i = 0; i < 30 * 60 * 6 && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) {
      const w = e.data.weapon;
      if (w !== 'pistol' && w !== 'smg' && w !== 'rifle') continue;
      const by = skill.get(e.data.by as number); if (!by) continue;
      if (e.type === 'shot') shots[by] = (shots[by] ?? 0) + 1;
      if (e.type === 'hit' && e.data.target !== e.data.by) hits[by] = (hits[by] ?? 0) + 1;
    }
  }
  console.log(`HITRESULT variant=${process.env.DIAG_NAME} seed=${SEED} shots=${JSON.stringify(shots)} hits=${JSON.stringify(hits)}`);
}, 3_600_000);

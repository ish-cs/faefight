import { describe, expect, test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { islandAt } from '../../src/sim/bots/nav';
import { Match } from '../../src/sim/match';
import { NO_INPUT } from '../../src/sim/types';
import type { Difficulty, Snapshot } from '../../src/sim/types';

const LIMIT = 25 * 60 * 30;

type Use = { buys: number; fire: number; latch: number; yank: number; miss: number };

/** One bot match to the end; per-phase counts of every grappling hook event, and hooks bought. */
async function play(diffs: Difficulty[], seed: number) {
  const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed });
  const use: Use = { buys: 0, fire: 0, latch: 0, yank: 0, miss: 0 };
  let snap: Snapshot = m.tick(new Map());
  const had = new Map<number, number>();
  for (let i = 0; i < LIMIT && snap.winner === null; i++) {
    snap = m.tick(new Map());
    for (const e of snap.events) if (e.type === 'grapple' && String(e.data.phase) in use) use[String(e.data.phase) as keyof Use]++;
    for (const p of snap.players) {
      const n = p.inv.grapples ?? 0, before = had.get(p.id) ?? 0;
      if (n > before && p.alive) use.buys++;
      had.set(p.id, n);
    }
  }
  m.dispose();
  return { use, winner: snap.winner, min: snap.time / 60 };
}

describe('bots and the grappling hook', () => {
  test('bots buy hooks and use them (cross / escape / yank) in most games', async () => {
    const games: { diffs: Difficulty[]; seed: number }[] = [
      { diffs: ['pro', 'hard'], seed: 1 }, { diffs: ['hard', 'medium'], seed: 2 }, { diffs: ['pro', 'medium'], seed: 3 },
      { diffs: ['hard', 'pro', 'medium', 'hard'], seed: 4 }, { diffs: ['pro', 'hard', 'hard', 'medium'], seed: 5 },
      { diffs: ['medium', 'hard'], seed: 6 },
    ];
    let used = 0;
    const lines: string[] = [];
    for (const g of games) {
      const r = await play(g.diffs, g.seed);
      const latched = r.use.latch + r.use.yank;
      if (latched > 0) used++;
      lines.push(`seed ${g.seed} ${g.diffs.join('/')}: ${JSON.stringify(r.use)} winner ${r.winner} at ${r.min.toFixed(1)} min`);
    }
    console.log(`grappling hook use:\n  ${lines.join('\n  ')}`);
    expect(used).toBeGreaterThanOrEqual(Math.ceil(games.length * 0.6));
  }, 900_000);

  test('never strands itself: PRO vs a passive opponent, seed 1 (it used to hook to the center with its last hook and stay there)', async () => {
    const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: 'pro' }, { name: '', isBot: true, difficulty: 'easy' }], seed: 1 },
      { makeBot: (id, d, rng) => (id === 1 ? new Bot(id, d, rng) : { think: (v) => ({ ...NO_INPUT, yaw: v.self.yaw, pitch: v.self.pitch }) }) });
    let snap: Snapshot = m.tick(new Map());
    let offSince: number | null = null, worst = 0, hooks = 0;
    for (let i = 0; i < 12 * 60 * 30 && snap.winner === null; i++) {
      snap = m.tick(new Map());
      const p = snap.players[0];
      for (const e of snap.events) if (e.type === 'grapple' && e.data.by === 1 && e.data.phase === 'latch') hooks++;
      // Off every player island with no hook left: on the center or a bridge, the way a stranded bot sat.
      const off = p.alive && islandAt(m.map, p.pos) < 0 && !(p.inv.grapples ?? 0);
      if (!off) offSince = null;
      else { offSince ??= snap.time; worst = Math.max(worst, snap.time - offSince); }
    }
    m.dispose();
    console.log(`seed 1 PRO vs passive: winner ${snap.winner} at ${(snap.time / 60).toFixed(1)} min, ${hooks} hooks, longest hookless off-island stretch ${worst.toFixed(0)} s`);
    expect(hooks).toBeGreaterThan(0);
    expect(worst).toBeLessThan(60);
    expect(snap.winner).toBe(1);
  }, 600_000);

  test('cut off on the center with cash: buys a hook from the seller and hooks home, without dying', async () => {
    let bot: Bot | null = null;
    const m = await Match.create({ players: [{ name: '', isBot: true, difficulty: 'pro' }, { name: '', isBot: true, difficulty: 'easy' }], seed: 1 },
      { makeBot: (id, d, rng) => (id === 1 ? (bot = new Bot(id, d, rng)) : { think: (v) => ({ ...NO_INPUT, yaw: v.self.yaw, pitch: v.self.pitch }) }) });
    let snap: Snapshot = m.tick(new Map());
    const c = m.def.center;
    m.debugTeleport(1, { x: c.goldGen.x, y: c.goldGen.y + 0.1, z: c.goldGen.z });
    m.debugGive(1, { cash: 400 });
    const home = m.map[snap.players[0].island];
    let bought = false, homeAt: number | null = null;
    for (let i = 0; i < 90 * 30 && homeAt === null; i++) {
      snap = m.tick(new Map());
      const p = snap.players[0];
      if ((p.inv.grapples ?? 0) > 0) bought = true;
      if (p.alive && Math.hypot(p.pos.x - home.center.x, p.pos.z - home.center.z) < home.radius) homeAt = snap.time;
    }
    m.dispose();
    console.log(`cut off on the center: bought a hook ${bought}, home at ${homeAt?.toFixed(1)} s, deaths ${snap.players[0].deaths}, last note ${bot!.hookNote?.text}`);
    expect(bought).toBe(true);
    expect(homeAt).not.toBeNull();
    expect(snap.players[0].deaths).toBe(0);
  }, 300_000);
});

import { test } from 'vitest';
import { Bot } from '../../src/sim/bots/bot';
import { Match } from '../../src/sim/match';
import type { Difficulty } from '../../src/sim/types';

const SEEDS = (process.env.DIAG_SEEDS ?? '3').split(',').map(Number);
test('diag build', async () => {
  const diffs: Difficulty[] = ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'];
  for (const seed of SEEDS) {
    const bots = new Map<number, Bot>();
    const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
      { makeBot: (id, d, rng) => { const b = new Bot(id, d, rng); bots.set(id, b); return b; } });
    let snap = m.tick(new Map());
    type S = { placed: number; got: Record<string, number>; goals: Record<string, number>; deaths: number; cash: number; vault: number; ticks: number; full: number; pieceTicks: number; healTicks: number; medBuys: number; nulls: number; hp: number };
    const st = new Map<number, S>();
    const prevPieces = new Map<number, Record<string, number>>(); const alive = new Map<number, boolean>(); const prevMed = new Map<number, number>();
    for (let i = 0; i < 25 * 60 * 30 && snap.winner === null; i++) {
      snap = m.tick(new Map());
      for (const e of snap.events) if (e.type === 'placed' && e.data.kind !== 'scaffold') { const s = st.get(e.data.by as number); if (s) s.placed++; }
      for (const p of snap.players) {
        let s = st.get(p.id);
        if (!s) { s = { placed: 0, got: {}, goals: {}, deaths: 0, cash: 0, vault: 0, ticks: 0, full: 0, pieceTicks: 0, healTicks: 0, medBuys: 0, nulls: 0, hp: 0 }; st.set(p.id, s); }
        if (alive.get(p.id) && !p.alive) s.deaths++;
        alive.set(p.id, p.alive);
        if (!p.alive) continue;
        const b = bots.get(p.id) as any;
        const g = String(b.goal); s.goals[g] = (s.goals[g] ?? 0) + 1;
        s.ticks++; s.cash += p.inv.cash; s.vault += p.vault.cash;
        s.nulls += p.hotbar.filter((h: any) => h === null).length;
        if (p.hotbar.includes('healPotion' as any)) s.hp++;
        if (p.hotbar.every((h: any) => h !== null && h !== undefined && h !== '')) s.full++;
        const pieces = { ...(p.inv.pieces as Record<string, number>) };
        const nonScaf = Object.entries(pieces).filter(([k]) => k !== 'scaffold').reduce((a, [, n]) => a + (n ?? 0), 0);
        if (nonScaf > 0) s.pieceTicks++;
        const prev = prevPieces.get(p.id) ?? {};
        for (const [k, n] of Object.entries(pieces)) if ((n ?? 0) > (prev[k] ?? 0)) s.got[k] = (s.got[k] ?? 0) + (n - (prev[k] ?? 0));
        prevPieces.set(p.id, pieces);
        const med = p.inv.medkits; if (med > (prevMed.get(p.id) ?? 0)) s.medBuys += med - (prevMed.get(p.id) ?? 0); prevMed.set(p.id, med);
      }
    }
    const out: string[] = [`seed ${seed}: winner ${snap.winner} at ${(snap.time / 60).toFixed(1)} min`];
    for (const [id, b] of bots) {
      const s = st.get(id)!;
      const top = Object.entries(s.goals).sort((a, c) => c[1] - a[1]).slice(0, 7).map(([g, n]) => `${g}:${(n / 30).toFixed(0)}`).join(' ');
      out.push(`#${id} ${b.difficulty.padEnd(6)} ${b.personality.archetype.padEnd(9)} placed ${s.placed} deaths ${s.deaths} got ${JSON.stringify(s.got)} med+${s.medBuys} cash~${(s.cash / s.ticks).toFixed(0)} vault~${(s.vault / s.ticks).toFixed(0)} full ${(100 * s.full / s.ticks).toFixed(0)}% pieces ${(100 * s.pieceTicks / s.ticks).toFixed(0)}% free~${(s.nulls / s.ticks).toFixed(1)} hpot ${(100 * s.hp / s.ticks).toFixed(0)}% | ${top}`);
    }
    console.log(out.join('\n'));
  }
}, 3_600_000);

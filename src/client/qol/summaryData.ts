import type { PlayerStats } from '../../sim/types';

/** End-of-match awards (pure). */
export type AwardKey = 'mvp' | 'builder' | 'sealer' | 'sharpshooter' | 'warlord';
export type Award = { key: AwardKey; title: string; id: number; detail: string };

export const mvpScore = (s: PlayerStats) => s.kills * 100 + s.damage + s.seals * 150 - s.deaths * 25;

/** Best player by `score` (must be > 0), ties broken by `tie`, then lowest id. */
function best(stats: PlayerStats[], score: (s: PlayerStats) => number, tie: (s: PlayerStats) => number): PlayerStats | null {
  let top: PlayerStats | null = null;
  for (const s of stats) {
    if (score(s) <= 0) continue;
    if (!top || score(s) > score(top) || (score(s) === score(top) && (tie(s) > tie(top) || (tie(s) === tie(top) && s.id < top.id)))) top = s;
  }
  return top;
}

export function awards(stats: PlayerStats[]): Award[] {
  const out: Award[] = [];
  const mvp = best(stats, mvpScore, (s) => s.kills);
  if (mvp) out.push({ key: 'mvp', title: 'MVP', id: mvp.id, detail: `${mvp.kills} kills · ${mvp.damage} dmg` });
  const b = best(stats, (s) => s.built, (s) => s.seals);
  if (b) out.push({ key: 'builder', title: 'Builder', id: b.id, detail: `${b.built} piece${b.built > 1 ? 's' : ''}` });
  const se = best(stats, (s) => s.seals, (s) => s.built);
  if (se) out.push({ key: 'sealer', title: 'Sealer', id: se.id, detail: `${se.seals} bunker${se.seals > 1 ? 's' : ''} sealed` });
  const sh = best(stats, (s) => s.headshots, (s) => s.damage);
  if (sh) out.push({ key: 'sharpshooter', title: 'Sharpshooter', id: sh.id, detail: `${sh.headshots} headshot${sh.headshots > 1 ? 's' : ''}` });
  const w = best(stats, (s) => s.elims ?? 0, (s) => s.spoils ?? 0);
  if (w) out.push({ key: 'warlord', title: 'Warlord', id: w.id, detail: `${w.elims} elimination${w.elims > 1 ? 's' : ''} · $${w.spoils ?? 0} spoils` });
  return out;
}

/** 83.4 → "1:23". */
export function fmtLife(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Summary rows: MVP score order. */
export function summaryOrder(stats: PlayerStats[]): PlayerStats[] {
  return [...stats].sort((a, b) => mvpScore(b) - mvpScore(a) || b.kills - a.kills || a.id - b.id);
}

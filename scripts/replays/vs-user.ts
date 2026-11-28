/// <reference types="node" />
/**
 * "Win rate vs the real user" tracker (bot-cognition spec §7.4 ground truth). Ingests every new .faereplay with a
 * human player (default: ~/Downloads, top level only) into a local CSV (default .replays-local/vs-user.csv, gitignored:
 * the user's games are private), one row per match, and prints the rolling 10-game bot-win rate over games with Hard
 * bots (a game counts as a bot win when the user did not win; unfinished games are logged but not counted).
 *
 *   npx tsx scripts/replays/vs-user.ts [<dirs/files>...] [--csv path] [--window 10]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReplays, playerStats } from './extract';
import { userReplayFiles } from './macros';
import { LOCAL_DIR } from './userproxy';

export const HEADER = ['date', 'replay_id', 'file', 'tiers', 'bots', 'minutes', 'finished', 'user_won', 'placement', 'players', 'kills', 'deaths', 'seals'] as const;
export type VsRow = Record<(typeof HEADER)[number], string>;

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function parseCsv(text: string): VsRow[] {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',');
  if (head.join(',') !== HEADER.join(',')) throw new Error(`vs-user: CSV header is "${lines[0]}", expected "${HEADER.join(',')}"`);
  return lines.slice(1).map((l) => {
    const cells: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(HEADER.map((h, i) => [h, cells[i] ?? ''])) as VsRow;
  });
}
export const toCsvLine = (r: VsRow) => HEADER.map((h) => csvCell(r[h])).join(',');

/** Wilson score interval (95%). */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, den = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / den, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Bot-win rate over the last `n` finished games that had at least one bot of `tier`. */
export function rolling(rows: VsRow[], tier = 'hard', n = 10): { games: number; botWins: number; rate: number | null; ci: [number, number] } {
  const xs = rows.filter((r) => r.finished === '1' && r.tiers.split(' ').some((t) => t.startsWith(`${tier}×`))).sort((a, b) => a.date.localeCompare(b.date)).slice(-n);
  const botWins = xs.filter((r) => r.user_won === '0').length;
  return { games: xs.length, botWins, rate: xs.length ? botWins / xs.length : null, ci: wilson(botWins, xs.length) };
}

export async function ingest(paths: string[], csvPath: string): Promise<{ added: VsRow[]; rows: VsRow[] }> {
  const rows = fs.existsSync(csvPath) ? parseCsv(fs.readFileSync(csvPath, 'utf8')) : [];
  const seen = new Set(rows.map((r) => r.replay_id));
  const added: VsRow[] = [];
  for (const { file, replay: r } of await loadReplays(paths)) {
    const key = `${r.header.matchId}#${r.header.segment}`;
    if (seen.has(key)) continue;
    const human = r.header.players.find((p) => p.id === r.header.localId && !p.isBot) ?? r.header.players.find((p) => !p.isBot);
    if (!human) continue; // all-bot game: nothing to learn about the user
    const st = playerStats(file, r).find((p) => p.id === human.id)!;
    const tiers = new Map<string, number>();
    for (const p of r.header.players) if (p.isBot) tiers.set(p.difficulty ?? 'bot', (tiers.get(p.difficulty ?? 'bot') ?? 0) + 1);
    const finished = !r.footer.unfinished;
    const row: VsRow = {
      date: new Date(r.header.recordedAt).toISOString(), replay_id: key, file: path.basename(file),
      tiers: [...tiers].map(([t, k]) => `${t}×${k}`).join(' '), bots: String(r.header.players.filter((p) => p.isBot).length),
      minutes: (r.footer.duration / 60).toFixed(1), finished: finished ? '1' : '0', user_won: finished ? (r.footer.winner === human.id ? '1' : '0') : '',
      placement: finished ? String(st.place) : '', players: String(r.header.players.length), kills: String(st.kills), deaths: String(st.deaths), seals: String(st.seals.successes),
    };
    seen.add(key);
    added.push(row);
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    const fresh = !fs.existsSync(csvPath);
    fs.appendFileSync(csvPath, (fresh ? HEADER.join(',') + '\n' : '') + added.map(toCsvLine).join('\n') + '\n');
  }
  return { added, rows: [...rows, ...added] };
}

async function main(argv: string[]) {
  const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
  const paths = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const csvPath = opt('csv', path.join(LOCAL_DIR, 'vs-user.csv')), win = Number(opt('window', '10'));
  const { added, rows } = await ingest(paths.length ? paths : userReplayFiles(), csvPath);
  console.log(`vs-user: ${added.length} new game(s) → ${csvPath} (${rows.length} in all)`);
  console.log('| date | tiers | finished | user won | place | kills | deaths | seals |\n|---|---|---|---|---|---|---|---|');
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date)).slice(-12)) console.log(`| ${r.date.slice(0, 16)} | ${r.tiers} | ${r.finished === '1' ? 'yes' : 'no'} | ${r.user_won || '-'} | ${r.placement || '-'}/${r.players} | ${r.kills} | ${r.deaths} | ${r.seals} |`);
  for (const tier of ['hard', 'pro', 'medium']) {
    const x = rolling(rows, tier, win);
    if (!x.games) continue;
    console.log(`${tier}: bots won ${x.botWins}/${x.games} of the last ${win} finished games with ${tier} bots = ${(100 * x.rate!).toFixed(0)}% (Wilson 95% ${(100 * x.ci[0]).toFixed(0)}–${(100 * x.ci[1]).toFixed(0)}%)${tier === 'hard' ? ' · target ≥ 70%' : ''}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });

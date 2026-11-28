/// <reference types="node" />
/**
 * Hindsight macro labeller (bot-cognition spec §4.1): every 5 s window of every player in a replay gets one macro
 * label (src/sim/bots/userProxy.ts MACROS) from the recorded data alone (per-second summaries + event log), plus the
 * feature vector at the window's start (userProxy.ts features). No re-simulation, so old replays stay usable.
 *
 * Rules, first match wins (window [t, t+5 s]):
 *   seal       sealed a rival's bunker, or put a piece at a rival's bunker (within SEAL.half + 1 m)
 *   hunt       killed someone whose bunker was sealed (or who was trapped) at t
 *   fight      hit or killed another player
 *   disengage  hp + shield < 80 at t, and then healed (+15) or got ≥ 5 m further from the nearest enemy
 *   bank       carried cash dropped ≥ 25 (alive) on my island, nearer my vault than my shop
 *   shop       cash dropped ≥ 25 (alive) anywhere else, or a new gun in hand
 *   push       ended on a rival's island, or out over the water ≥ 5 m further from home, or built a bridge piece
 *   fortify    built on my own island
 *   center     ended on the centre island
 *   hold       anything else (collecting, waiting at home)
 *
 *   npx tsx scripts/replays/macros.ts [<replays>...]   (default: ~/Downloads/*.faereplay) → label counts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEAL, TICK_HZ } from '../../src/sim/constants';
import { MACROS, features, GUNS, whereOf, type Macro } from '../../src/sim/bots/userProxy';
import type { Replay, SecondSummary } from '../../src/sim/replay/format';
import { loadReplays, type LoadedReplay } from './extract';

export const WINDOW_SEC = 5;
/** Summary row columns (format.ts SecondSummary). */
const C = { id: 0, x: 1, y: 2, z: 3, hp: 4, shield: 5, alive: 6, cash: 7, kills: 8, deaths: 9, equipped: 10, ads: 11, elim: 12 } as const;

export type Moment = {
  replay: string; replayId: string; player: number; isHuman: boolean; difficulty: string | null;
  /** Window start (s) and tick. */
  t: number; tick: number;
  x: number[]; y: number; macro: Macro;
};

/** The user's replays: every *.faereplay directly in `dir` (default ~/Downloads). Never recurses (Downloads holds apps). */
export function userReplayFiles(dir = path.join(os.homedir(), 'Downloads')): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.faereplay')).sort().map((f) => path.join(dir, f));
}

type Row = (number | string)[];
const num = (r: Row, c: number) => Number(r[c]);
const d2 = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** Per-second rows by player id: rows[id][k] = row at seconds[k] (undefined if the player is missing that second). */
function rowsById(seconds: SecondSummary[]): Map<number, (Row | undefined)[]> {
  const out = new Map<number, (Row | undefined)[]>();
  seconds.forEach((s, k) => { for (const r of s.p) { const id = Number(r[C.id]); (out.get(id) ?? out.set(id, []).get(id)!)[k] = r; } });
  return out;
}

export function labelReplay(file: string, r: Replay, opts: { humansOnly?: boolean } = {}): Moment[] {
  const S = r.seconds;
  if (S.length < WINDOW_SEC + 2) return [];
  const map = r.header.map;
  const rows = rowsById(S);
  const islandOf = new Map(r.header.players.map((p) => [p.id, p.island]));
  const byTick = (t0: number, t1: number) => r.events.filter(([t]) => t >= t0 && t < t1);
  const out: Moment[] = [];
  for (const pl of r.header.players) {
    if (opts.humansOnly && pl.isBot) continue;
    const my = rows.get(pl.id);
    if (!my) continue;
    const home = map.find((i) => i.index === pl.island);
    if (!home) continue;
    // Guns owned: seen in hand (or fired) since the last respawn.
    const owned: Set<string>[] = [];
    let cur = new Set<string>();
    const firedAt = new Map<number, string[]>();
    for (const [t, type, d] of r.events) if (type === 'hit' && d.by === pl.id && typeof d.weapon === 'string') {
      const k = Math.floor(t / TICK_HZ); (firedAt.get(k) ?? firedAt.set(k, []).get(k)!).push(d.weapon);
    }
    for (let k = 0; k < S.length; k++) {
      const row = my[k];
      if (!row || num(row, C.alive) === 0) cur = new Set();
      else {
        const eq = String(row[C.equipped]);
        if ((GUNS as readonly string[]).includes(eq)) cur.add(eq);
        for (const w of firedAt.get(k) ?? []) if ((GUNS as readonly string[]).includes(w)) cur.add(w);
      }
      owned[k] = new Set(cur);
    }
    for (let k = WINDOW_SEC; k + WINDOW_SEC < S.length; k += WINDOW_SEC) {
      const a = my[k], b = my[k + WINDOW_SEC];
      if (!a || !b || num(a, C.elim) || num(a, C.alive) === 0) continue;
      let aliveAll = true;
      for (let j = k; j <= k + WINDOW_SEC; j++) if (!my[j] || num(my[j]!, C.alive) === 0) aliveAll = false;
      const pos = { x: num(a, C.x), z: num(a, C.z) }, posB = { x: num(b, C.x), z: num(b, C.z) };
      const enemiesAt = (j: number) => S[j].p.filter((o) => Number(o[C.id]) !== pl.id && num(o, C.alive) === 1 && !num(o, C.elim)).map((o) => ({ x: num(o, C.x), z: num(o, C.z) }));
      const rivalIslands = S[k].p.filter((o) => Number(o[C.id]) !== pl.id && !num(o, C.elim)).map((o) => islandOf.get(Number(o[C.id]))!).filter((i) => i !== undefined);
      const deadRivalIslands = S[k].p.filter((o) => Number(o[C.id]) !== pl.id && !num(o, C.elim) && num(o, C.alive) === 0).map((o) => islandOf.get(Number(o[C.id]))!).filter((i) => i !== undefined);
      const t0 = S[k].tick, t1 = S[k + WINDOW_SEC].tick;
      const hurt = byTick(t0 - WINDOW_SEC * TICK_HZ, t0).some(([, type, d]) => type === 'hit' && d.target === pl.id && d.by !== null && d.by !== pl.id);
      const x = features({
        hp: num(a, C.hp), shield: num(a, C.shield), cash: num(a, C.cash), guns: [...owned[k]], pos, island: pl.island,
        enemies: enemiesAt(k), map, sealed: S[k].sealed, rivalIslands, deadRivalIslands, now: S[k].t, hurtRecently: hurt,
      });
      const ev = byTick(t0, t1);
      const mine = (key: string) => ev.filter(([, , d]) => d[key] === pl.id);
      const rivalBunker = (p: { x: number; z: number }) => map.find((i) => i.index !== pl.island && d2(i.bunker.center, p) <= SEAL.half + 1);
      const placed = mine('by').filter(([, type]) => type === 'placed').map(([, , d]) => d.pos as { x: number; z: number }).filter(Boolean);
      let macro: Macro;
      const sealedNow = (vid: number) => { const isl = islandOf.get(vid); return isl !== undefined && !!S[k].sealed[isl]; };
      const trapped = new Set(byTick(0, t1).filter(([, type]) => type === 'trapped').map(([, , d]) => d.player as number));
      const enemyD = (j: number, p: { x: number; z: number }) => Math.min(Infinity, ...enemiesAt(j).map((e) => d2(e, p)));
      if (ev.some(([, type, d]) => type === 'sealed' && d.by === pl.id && d.owner !== pl.id) || placed.some((p) => rivalBunker(p))) macro = 'seal';
      else if (ev.some(([, type, d]) => type === 'kill' && d.killer === pl.id && d.victim !== pl.id && (sealedNow(d.victim as number) || trapped.has(d.victim as number)))) macro = 'hunt';
      else if (ev.some(([, type, d]) => (type === 'hit' && d.by === pl.id && d.target !== pl.id) || (type === 'kill' && d.killer === pl.id && d.victim !== pl.id))) macro = 'fight';
      else if (aliveAll && num(a, C.hp) + num(a, C.shield) < 80 && (num(b, C.hp) + num(b, C.shield) >= num(a, C.hp) + num(a, C.shield) + 15 || enemyD(k + WINDOW_SEC, posB) >= enemyD(k, pos) + 5)) macro = 'disengage';
      else {
        let spent: { x: number; z: number } | null = null;
        for (let j = k + 1; j <= k + WINDOW_SEC && aliveAll; j++) if (num(my[j]!, C.cash) <= num(my[j - 1]!, C.cash) - 25) { spent = { x: num(my[j]!, C.x), z: num(my[j]!, C.z) }; break; }
        const newGun = [...owned[k + WINDOW_SEC]].some((g) => !owned[k].has(g)) && aliveAll;
        const onHome = (p: { x: number; z: number }) => d2(home.center, p) <= home.radius;
        const whereB = whereOf(map, pl.island, posB);
        if (spent && onHome(spent) && d2(home.vault, spent) < d2(home.shop, spent) && !newGun) macro = 'bank';
        else if (spent || newGun) macro = 'shop';
        else if (whereB === 1 || (whereB === 3 && d2(home.center, posB) >= d2(home.center, pos) + 5) || placed.some((p) => !onHome(p) && !rivalBunker(p))) macro = 'push';
        else if (placed.some(onHome)) macro = 'fortify';
        else if (whereB === 2) macro = 'center';
        else macro = 'hold';
      }
      out.push({ replay: path.basename(file), replayId: r.header.id, player: pl.id, isHuman: !pl.isBot, difficulty: pl.difficulty ?? null, t: S[k].t, tick: t0, x, y: MACROS.indexOf(macro), macro });
    }
  }
  return out;
}

export function labelAll(replays: LoadedReplay[], opts: { humansOnly?: boolean } = {}): Moment[] {
  return replays.flatMap(({ file, replay }) => labelReplay(file, replay, opts));
}

export function macroCounts(ms: Moment[]): Record<Macro, number> {
  const out = Object.fromEntries(MACROS.map((m) => [m, 0])) as Record<Macro, number>;
  for (const m of ms) out[m.macro]++;
  return out;
}

async function main(argv: string[]) {
  const files = argv.length ? argv : userReplayFiles();
  const reps = await loadReplays(files);
  const all = labelAll(reps);
  const human = all.filter((m) => m.isHuman), bots = all.filter((m) => !m.isHuman);
  const share = (ms: Moment[]) => Object.entries(macroCounts(ms)).map(([k, n]) => `${k} ${(100 * n / Math.max(1, ms.length)).toFixed(0)}%`).join(' · ');
  console.log(`${reps.length} replays · ${human.length} user windows · ${bots.length} bot windows`);
  console.log(`user: ${share(human)}`);
  for (const d of ['easy', 'medium', 'hard', 'pro']) { const b = bots.filter((m) => m.difficulty === d); if (b.length) console.log(`${d} (${b.length}): ${share(b)}`); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });

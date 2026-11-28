/// <reference types="node" />
/**
 * Replay state reconstruction (bot-cognition spec §7.1). matchFromReplay needs a bit-exact re-run, which breaks as
 * soon as the sim or bot code changes (older replays diverge at tick 30). Instead: a fresh match on the same setup and
 * seed, then the recorded state at a second of the match is put back with debug ops:
 *   - match clock (debugSetTime);
 *   - pieces standing then (placed − destroyed events), full hp, same owner (debugPlacePiece); seals follow from them;
 *   - each player: eliminated / dead (debugEliminate / debugKill), position, hp, shield, carried cash, guns seen in hand
 *     or fired since the last respawn (full mag + one spare), and a fixed small build kit (KIT; not recorded).
 * Not recorded, so not restored: vault cash, materials, heals, generator levels/stored cash, breakout clocks, bots'
 * memory. Every seat becomes a bot (factory decides who plays which seat). It is robust across builds.
 *
 * fidelity() compares the rebuilt match with the recording a tick later: a moment is "usable" when every player's
 * alive/eliminated state and seal state match, alive players are within POS_TOL m, and the piece count is within
 * PIECE_TOL of the recorded count.
 *
 *   npx tsx scripts/replays/reconstruct.ts [<replays>...]   (default ~/Downloads/*.faereplay) → usable-moment report
 */
import { pathToFileURL } from 'node:url';
import { Bot } from '../../src/sim/bots/bot';
import { TICK_HZ, WEAPONS } from '../../src/sim/constants';
import { Match, type MatchOptions } from '../../src/sim/match';
import type { Replay, SecondSummary } from '../../src/sim/replay/format';
import type { Difficulty, Inventory, PieceKind, PlayerState, Snapshot, WeaponKind } from '../../src/sim/types';
import { GUNS } from '../../src/sim/bots/userProxy';
import { loadReplays, mineScenarios } from './extract';
import { labelReplay, userReplayFiles } from './macros';

export const POS_TOL = 1.5, PIECE_TOL = 0.1;
/** Build kit every alive player gets (materials aren't recorded): enough for a short bridge and a seal. */
export const KIT: Partial<Record<PieceKind, number>> = { scaffold: 6, wood: 4 };
const C = { id: 0, x: 1, y: 2, z: 3, hp: 4, shield: 5, alive: 6, cash: 7, equipped: 10, elim: 12 } as const;

type Internals = { s: { players: Map<number, PlayerState>; time: number }; makeBot?: MatchOptions['makeBot'] };

/** Summary row for second k at or before `tick`. */
export function secondAt(r: Replay, tick: number): { k: number; s: SecondSummary } | null {
  let lo = 0, hi = r.seconds.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (r.seconds[m].tick <= tick) { at = m; lo = m + 1; } else hi = m - 1; }
  return at < 0 ? null : { k: at, s: r.seconds[at] };
}

/** Guns each player had in hand or fired since their last respawn, up to second k. */
function gunsAt(r: Replay, k: number): Map<number, Set<WeaponKind>> {
  const out = new Map<number, Set<WeaponKind>>();
  const fired = new Map<string, WeaponKind[]>();
  const tickK = r.seconds[k].tick;
  for (const [t, type, d] of r.events) {
    if (t > tickK) break;
    if (type === 'hit' && typeof d.by === 'number' && (GUNS as readonly string[]).includes(d.weapon as string)) {
      const key = `${d.by}:${Math.floor(t / TICK_HZ)}`;
      (fired.get(key) ?? fired.set(key, []).get(key)!).push(d.weapon as WeaponKind);
    }
  }
  for (let j = 0; j <= k; j++) for (const row of r.seconds[j].p) {
    const id = Number(row[C.id]);
    if (Number(row[C.alive]) === 0) { out.set(id, new Set()); continue; }
    const set = out.get(id) ?? out.set(id, new Set()).get(id)!;
    const eq = String(row[C.equipped]);
    if ((GUNS as readonly string[]).includes(eq)) set.add(eq as WeaponKind);
    for (const w of fired.get(`${id}:${r.seconds[j].t}`) ?? []) set.add(w);
  }
  return out;
}

export type Rebuilt = { match: Match; second: SecondSummary; k: number; pieceIds: Map<number, number> };

/**
 * Fresh match on the replay's setup + seed with the state at the last recorded second at or before `tick`.
 * `makeBot` builds every seat (humans included); `difficultyOf` picks each seat's tier (default: recorded, humans 'hard').
 */
export async function reconstruct(r: Replay, tick: number, makeBot: NonNullable<MatchOptions['makeBot']> = (id, d, rng) => new Bot(id, d, rng),
  difficultyOf: (p: Replay['header']['players'][number]) => Difficulty = (p) => p.difficulty ?? 'hard'): Promise<Rebuilt> {
  const at = secondAt(r, tick);
  if (!at) throw new Error(`reconstruct: no summary at or before tick ${tick}`);
  const setup = { ...r.header.setup, players: r.header.setup.players.map((p, i) => ({ ...p, isBot: true, difficulty: difficultyOf(r.header.players[i]) })) };
  const m = await Match.create(setup, { makeBot });
  for (const isl of r.header.map) {
    const mine = m.map[isl.index];
    if (!mine || Math.hypot(mine.center.x - isl.center.x, mine.center.z - isl.center.z) > 0.5) { m.dispose(); throw new Error(`reconstruct: map differs from the recording (island ${isl.index})`); }
  }
  const mi = m as unknown as Internals;
  mi.s.time = at.s.t;
  // Pieces standing at that second.
  const live = new Map<number, { kind: PieceKind; pos: { x: number; y: number; z: number }; rotY: number; owner: number }>();
  for (const [t, type, d] of r.events) {
    if (t > at.s.tick) break;
    if (type === 'placed') live.set(d.piece as number, { kind: d.kind as PieceKind, pos: d.pos as never, rotY: Number(d.rotY) || 0, owner: Number(d.by) || 0 });
    else if (type === 'destroyed') live.delete(d.piece as number);
  }
  const pieceIds = new Map<number, number>();
  for (const [old, p] of live) pieceIds.set(old, m.debugPlacePiece(p.kind, p.pos, p.rotY, p.owner));
  // Players.
  const guns = gunsAt(r, at.k);
  const warn = console.warn;
  console.warn = () => {}; // debugGive warns when the hotbar is full; the kit then rides along without a slot
  try {
    for (const row of at.s.p) {
      const id = Number(row[C.id]);
      const p = mi.s.players.get(id);
      if (!p) continue;
      if (Number(row[C.elim])) { m.debugEliminate(id); continue; }
      if (Number(row[C.alive]) === 0) { m.debugKill(id); continue; }
      m.debugTeleport(id, { x: Number(row[C.x]), y: Number(row[C.y]), z: Number(row[C.z]) });
      m.debugSetHp(id, Math.max(1, Number(row[C.hp])));
      m.debugSetShield(id, Math.max(0, Number(row[C.shield])));
      p.inv.cash = Math.max(0, Number(row[C.cash]));
      const give: Partial<Inventory> = { pieces: { ...KIT }, weapons: {} };
      for (const g of guns.get(id) ?? []) if (!p.inv.weapons[g]) give.weapons![g] = { mag: WEAPONS[g].mag, spare: WEAPONS[g].mag };
      m.debugGive(id, give);
    }
  } finally { console.warn = warn; }
  return { match: m, second: at.s, k: at.k, pieceIds };
}

export type Fidelity = { usable: boolean; maxPosErr: number; aliveMismatch: number; sealMismatch: number; pieces: number; recordedPieces: number; why: string[] };

/** Compare a snapshot of the rebuilt match (taken after one tick) with the recorded second it was built from. */
export function fidelity(snap: Snapshot, second: SecondSummary): Fidelity {
  let maxPosErr = 0, aliveMismatch = 0;
  for (const row of second.p) {
    const p = snap.players.find((x) => x.id === Number(row[C.id]));
    if (!p) { aliveMismatch++; continue; }
    const elim = !!Number(row[C.elim]), alive = Number(row[C.alive]) === 1;
    if (p.eliminated !== elim || (!elim && p.alive !== alive)) aliveMismatch++;
    if (alive && p.alive) maxPosErr = Math.max(maxPosErr, Math.hypot(p.pos.x - Number(row[C.x]), p.pos.z - Number(row[C.z])));
  }
  const sealMismatch = second.sealed.filter((v, i) => !!v !== !!snap.sealed[i]).length;
  const pieces = snap.pieces.length;
  const why: string[] = [];
  if (aliveMismatch) why.push(`alive×${aliveMismatch}`);
  if (sealMismatch) why.push(`seal×${sealMismatch}`);
  if (maxPosErr > POS_TOL) why.push(`pos ${maxPosErr.toFixed(1)}m`);
  if (Math.abs(pieces - second.pieces) > Math.max(2, PIECE_TOL * second.pieces)) why.push(`pieces ${pieces}/${second.pieces}`);
  return { usable: why.length === 0, maxPosErr, aliveMismatch, sealMismatch, pieces, recordedPieces: second.pieces, why };
}

/** Rebuild at `tick`, run one tick, check. Disposes the match unless `keep`. */
export async function rebuildAndCheck(r: Replay, tick: number, makeBot?: NonNullable<MatchOptions['makeBot']>): Promise<{ fid: Fidelity; rb: Rebuilt; snap: Snapshot }> {
  const rb = await reconstruct(r, tick, makeBot);
  const snap = rb.match.tick(new Map());
  return { fid: fidelity(snap, rb.second), rb, snap };
}

async function main(argv: string[]) {
  const reps = await loadReplays(argv.length ? argv : userReplayFiles());
  const tot = { scen: 0, scenOk: 0, win: 0, winOk: 0 };
  const whyAll: Record<string, number> = {};
  console.log('| replay | build | human | mined scenarios usable | user 5 s windows usable |\n|---|---|---|---|---|');
  for (const { file, replay: r } of reps) {
    const human = r.header.players.some((p) => !p.isBot);
    const scs = mineScenarios([{ file, replay: r }], { killLookback: 10, sealLookback: 25 });
    const wins = labelReplay(file, r, { humansOnly: true });
    const check = async (tick: number) => {
      const { fid, rb } = await rebuildAndCheck(r, tick);
      rb.match.dispose();
      for (const w of fid.why) { const k = w.split(/[ ×]/)[0]; whyAll[k] = (whyAll[k] ?? 0) + 1; }
      return fid.usable;
    };
    let sOk = 0, wOk = 0;
    for (const sc of scs) if (await check(sc.startTick)) sOk++;
    for (const w of wins) if (await check(w.tick)) wOk++;
    tot.scen += scs.length; tot.scenOk += sOk; tot.win += wins.length; tot.winOk += wOk;
    console.log(`| ${file.split('/').pop()} | ${r.header.build} | ${human ? 'yes' : 'no'} | ${sOk}/${scs.length} | ${wOk}/${wins.length} |`);
  }
  console.log(`| **all** | | | **${tot.scenOk}/${tot.scen}** | **${tot.winOk}/${tot.win}** |`);
  console.log('failure reasons:', JSON.stringify(whyAll));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });

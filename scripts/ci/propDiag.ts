/**
 * Diagnostics: how gameplay props (props.ts) touch bots in one headless game.
 *   tsx scripts/ci/propDiag.ts <scenario> <seed> [maxSec]
 * Per seat: ticks spent walking into a prop, stuck recoveries (and how many next to a prop), sight rays to an
 * enemy blocked by a prop, shots that hit a prop, kills, longest home sit. Measurement only, not used by the game.
 */
import { Match } from '../../src/sim/match';
import { Bot } from '../../src/sim/bots/bot';
import { Physics } from '../../src/sim/physics';
import { TICK_HZ } from '../../src/sim/constants';
type Scenario = 'ffa8-pro' | 'ffa8-hard' | 'ffa8-mixed' | '1v1-hard' | '1v1-pro-vs-hard';
type D = 'pro' | 'hard' | 'medium' | 'easy';
function seatsFor(sc: Scenario, seed: number): { diffs: D[]; maxSec: number } {
  if (sc === '1v1-hard') return { diffs: ['hard', 'hard'], maxSec: 1500 };
  if (sc === '1v1-pro-vs-hard') return { diffs: seed % 2 ? ['pro', 'hard'] : ['hard', 'pro'], maxSec: 1500 };
  if (sc === 'ffa8-mixed') return { diffs: ['pro', 'hard', 'medium', 'easy', 'pro', 'hard', 'medium', 'easy'], maxSec: 1080 };
  return { diffs: Array(8).fill(sc === 'ffa8-pro' ? 'pro' : 'hard'), maxSec: 1080 };
}

const [scenario, seedS, maxS] = process.argv.slice(2);
const seed = Number(seedS);
type Stat = { placeFail: number; placeFailProp: number; push: number; unstick: number; unstickNearProp: number; sightProp: number; sightOk: number; shotProp: number; shots: number; kills: number; deaths: number };
const stats = new Map<number, Stat>();
const st = (id: number) => stats.get(id) ?? (stats.set(id, { placeFail: 0, placeFailProp: 0, push: 0, unstick: 0, unstickNearProp: 0, sightProp: 0, sightOk: 0, shotProp: 0, shots: 0, kills: 0, deaths: 0 }), stats.get(id)!);

// Sight rays: Match.botView casts eye→chest with throughSlits=true and ignorePlayer=self; count prop blocks.
const P = Physics.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const rc = P.raycast;
let sightCaller: number | null = null;
P.raycast = function (this: Physics, ...a: unknown[]) {
  const h = rc.apply(this, a) as { hit: { type: string } } | null;
  if (sightCaller !== null && a[4] === true) {
    if (h?.hit.type === 'prop') st(sightCaller).sightProp++;
    else if (h?.hit.type === 'player') st(sightCaller).sightOk++;
  }
  return h;
};
const np = P.notePushes;
P.notePushes = function (this: { pushes: unknown[] }, id: unknown, ...rest: unknown[]) {
  const n = this.pushes.length;
  const r = np.call(this, id, ...rest);
  if (this.pushes.length > n) st(id as number).push++;
  return r;
};

const { diffs, maxSec } = seatsFor(scenario as Scenario, seed);
const bots: Bot[] = [];
const m = await Match.create({ players: diffs.map((d) => ({ name: '', isBot: true, difficulty: d })), seed },
  { makeBot: (id, d, rng) => (bots[id - 1] = new Bot(id, d, rng)) });
const defOf = (m as unknown as { def: { props?: { pos: { x: number; z: number } }[] } }).def;
const M = m as unknown as Record<string, (...a: unknown[]) => unknown>;
const bv = M.botView;
M.botView = function (self: unknown) {
  const id = (self as { id: number }).id;
  sightCaller = id;
  let v: { canPlace: (k: string, pos: { x: number; y: number; z: number }, r: number) => { ok: boolean; reason?: string } };
  try { v = bv.call(this, self) as typeof v; } finally { sightCaller = null; }
  const cp = v.canPlace;
  v.canPlace = (k, pos, r) => {
    const out = cp(k, pos, r);
    if (!out.ok && out.reason === 'blocked') {
      st(id).placeFail++;
      const poses = new Map((props?.poses() ?? []).map((q) => [q.id, q.p]));
      if ((defOf.props ?? []).some((q, i) => { const pp = poses.get(i + 1) ?? [q.pos.x, 0, q.pos.z]; return Math.hypot(pp[0] - pos.x, pp[2] - pos.z) < 2; })) st(id).placeFailProp++;
    }
    return out;
  };
  return v;
};
const props = m.debugProps();
const end = Math.round((Number(maxS) || maxSec) * TICK_HZ);
let snap = m.tick(new Map());
const lastUnstick = new Map<number, number>();
let snapTime = 0;
const pairs = new Map<string, { n: number; t0: number; t1: number }>();
const goalT = new Map<string, number>(), pushGoal = new Map<string, number>();
const curGoal = (i: number) => (bots[i] as unknown as { currentGoal?: string }).currentGoal ?? '?';
const np2 = P.notePushes;
P.notePushes = function (this: unknown, id: unknown, ...rest: unknown[]) {
  const g = curGoal((id as number) - 1);
  const before = (this as { pushes: unknown[] }).pushes.length;
  const r = np2.call(this, id, ...rest);
  const ps = (this as { pushes: { prop: number }[] }).pushes;
  if (ps.length > before) {
    pushGoal.set(g, (pushGoal.get(g) ?? 0) + 1);
    const k = `${g} bot${id} prop${ps[ps.length - 1].prop}`, e = pairs.get(k) ?? { n: 0, t0: snapTime, t1: 0 };
    e.n++; e.t1 = snapTime; pairs.set(k, e);
  }
  return r;
};
const home = new Map<number, number>(), longest = new Map<number, number>();
for (let t = 0; t < end && snap.winner === null; t++) {
  snap = m.tick(new Map());
  snapTime = snap.time;
  for (let i = 0; i < bots.length; i++) {
    const b = bots[i] as unknown as { unstickUntil: number }, id = i + 1;
    if (b.unstickUntil !== (lastUnstick.get(id) ?? -Infinity) && b.unstickUntil > snap.time) {
      st(id).unstick++;
      const p = snap.players[i].pos;
      if ((props?.poses() ?? []).some((q) => Math.hypot(q.p[0] - p.x, q.p[2] - p.z) < 1.8) ||
        (defOf.props ?? []).some((q) => Math.hypot(q.pos.x - p.x, q.pos.z - p.z) < 1.8)) st(id).unstickNearProp++;
    }
    lastUnstick.set(id, b.unstickUntil);
  }
  if (t % 15 === 0) for (const p of snap.players) if (p.alive) { const g = curGoal(p.id - 1); goalT.set(g, (goalT.get(g) ?? 0) + 0.5); }
  if (t % 15 === 0) for (const p of snap.players) {
    const b = m.map[p.island].bunker.center;
    const s = p.alive && Math.hypot(p.pos.x - b.x, p.pos.z - b.z) <= 12 ? (home.get(p.id) ?? 0) + 0.5 : 0;
    home.set(p.id, s); longest.set(p.id, Math.max(longest.get(p.id) ?? 0, s));
  }
  for (const e of snap.events) {
    if (e.type === 'kill') { const k = e.data.killer as number | null, v = e.data.victim as number; st(v).deaths++; if (k && k !== v) st(k).kills++; }
  }
}
// shots that hit a prop: Match records shot events from→to; a 'propHit'-like event may not exist, so re-cast nothing here.
console.log(JSON.stringify({ scenario, seed, time: Math.round(snap.time), winner: snap.winner, props: defOf.props?.length ?? 0 }));
for (let i = 0; i < diffs.length; i++) {
  const s = st(i + 1);
  console.log(`#${i + 1} ${diffs[i].padEnd(6)} placeFail ${s.placeFail} (prop ${s.placeFailProp})  push ${String(s.push).padStart(5)}t  unstick ${String(s.unstick).padStart(3)} (prop ${s.unstickNearProp})  sight prop/ok ${s.sightProp}/${s.sightOk}  k/d ${s.kills}/${s.deaths}  homeSit ${longest.get(i + 1) ?? 0}s`);
}
const fmt = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
console.log('goal sec:', fmt(goalT));
console.log('push ticks by goal:', fmt(pushGoal));
const sp = defOf.props as unknown as { id: number; kind: string; island: number; pos: { x: number; z: number } }[] | undefined;
for (const [k, e] of [...pairs].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
  const pid = Number(k.split('prop')[1]), q = sp?.find((x) => x.id === pid);
  const isl = q && q.island >= 0 ? m.map[q.island] : null;
  console.log(`${k} ${q?.kind} isl${q?.island} r${isl ? Math.hypot(q!.pos.x - isl.center.x, q!.pos.z - isl.center.z).toFixed(1) : '-'}: ${e.n} ticks, t ${Math.round(e.t0)}-${Math.round(e.t1)}`);
}
process.exit(0);

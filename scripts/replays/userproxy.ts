/// <reference types="node" />
/**
 * Fit the UserProxy macro tree (src/sim/bots/userProxy.ts) to the user's labelled windows (macros.ts), report its
 * leave-one-replay-out accuracy, and write the model (private: .replays-local/userproxy.json, gitignored).
 *
 *   npx tsx scripts/replays/userproxy.ts [<replays>...] [--out .replays-local/userproxy.json] [--depth 3] [--leaf 8]
 *                                        [--bias 0.4] [--difficulty hard]
 *
 * CI gets the model from the USERPROXY_MODEL repository secret: gh secret set USERPROXY_MODEL < .replays-local/userproxy.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FEATURES, MACROS, predict, type TreeNode, type UserProxyModel } from '../../src/sim/bots/userProxy';
import { PRESETS } from '../../src/sim/bots/personality';
import type { Difficulty } from '../../src/sim/types';
import { loadReplays } from './extract';
import { labelAll, userReplayFiles, type Moment } from './macros';

export const LOCAL_DIR = '.replays-local';

type XY = { x: number[]; y: number };

function gini(counts: number[], n: number): number {
  let s = 1;
  for (const c of counts) s -= (c / n) ** 2;
  return s;
}
const majority = (rows: XY[]) => {
  const c = MACROS.map(() => 0);
  for (const r of rows) c[r.y]++;
  return c.indexOf(Math.max(...c));
};

/** CART (Gini), depth ≤ maxDepth, leaves ≥ minLeaf rows. Deterministic (ties: lower feature, lower threshold). */
export function fitTree(rows: XY[], maxDepth = 6, minLeaf = 8): TreeNode {
  const grow = (rs: XY[], depth: number): TreeNode => {
    const leaf: TreeNode = { leaf: majority(rs), n: rs.length };
    if (depth >= maxDepth || rs.length < 2 * minLeaf) return leaf;
    const parent = MACROS.map(() => 0);
    for (const r of rs) parent[r.y]++;
    const g0 = gini(parent, rs.length);
    let best: { f: number; v: number; gain: number } | null = null;
    for (let f = 0; f < FEATURES.length; f++) {
      const sorted = [...rs].sort((a, b) => a.x[f] - b.x[f]);
      const left = MACROS.map(() => 0), right = [...parent];
      for (let i = 0; i < sorted.length - 1; i++) {
        left[sorted[i].y]++; right[sorted[i].y]--;
        const nl = i + 1, nr = sorted.length - nl;
        if (sorted[i].x[f] === sorted[i + 1].x[f] || nl < minLeaf || nr < minLeaf) continue;
        const gain = g0 - (nl * gini(left, nl) + nr * gini(right, nr)) / sorted.length;
        if (gain > 1e-9 && (!best || gain > best.gain + 1e-12)) best = { f, v: (sorted[i].x[f] + sorted[i + 1].x[f]) / 2, gain };
      }
    }
    if (!best) return leaf;
    const l = grow(rs.filter((r) => r.x[best!.f] <= best!.v), depth + 1), r = grow(rs.filter((r) => r.x[best!.f] > best!.v), depth + 1);
    // Both sides say the same: one leaf.
    if ('leaf' in l && 'leaf' in r && l.leaf === r.leaf) return leaf;
    return { f: best.f, v: Math.round(best.v * 1000) / 1000, l, r };
  };
  return grow(rows, 0);
}

export type CvResult = {
  byReplay: { replay: string; n: number; acc: number; majorityAcc: number }[];
  acc: number; majorityAcc: number; n: number;
  /** Per-macro recall on held-out windows: [hits, total]. */
  recall: Record<string, [number, number]>;
};

/** Leave-one-replay-out: fit on the other replays' user windows, score on this one's. */
export function crossValidate(ms: Moment[], depth = 6, leaf = 8): CvResult {
  const reps = [...new Set(ms.map((m) => m.replay))];
  const byReplay: CvResult['byReplay'] = [];
  const recall: CvResult['recall'] = Object.fromEntries(MACROS.map((m) => [m, [0, 0]]));
  let hit = 0, maj = 0;
  for (const rep of reps) {
    const train = ms.filter((m) => m.replay !== rep), test = ms.filter((m) => m.replay === rep);
    if (!test.length || !train.length) continue;
    const tree = fitTree(train, depth, leaf), mj = majority(train);
    let h = 0, mh = 0;
    for (const t of test) {
      const p = predict(tree, t.x);
      if (p === t.y) { h++; recall[MACROS[t.y]][0]++; }
      recall[MACROS[t.y]][1]++;
      if (mj === t.y) mh++;
    }
    hit += h; maj += mh;
    byReplay.push({ replay: rep, n: test.length, acc: h / test.length, majorityAcc: mh / test.length });
  }
  const n = byReplay.reduce((a, b) => a + b.n, 0);
  return { byReplay, acc: hit / Math.max(1, n), majorityAcc: maj / Math.max(1, n), n, recall };
}

export function treeText(t: TreeNode, ind = ''): string {
  if ('leaf' in t) return `${ind}→ ${MACROS[t.leaf]} (${t.n ?? '?'})\n`;
  return `${ind}${FEATURES[t.f]} <= ${t.v}\n${treeText(t.l, ind + '  ')}${ind}${FEATURES[t.f]} > ${t.v}\n${treeText(t.r, ind + '  ')}`;
}

export function buildModel(ms: Moment[], o: { depth: number; leaf: number; bias: number; difficulty: Difficulty; cv?: CvResult }): UserProxyModel {
  return {
    version: 1,
    tree: fitTree(ms, o.depth, o.leaf),
    bias: o.bias,
    difficulty: o.difficulty,
    // Sniper preset (rifle at range: the user's main habit, 61% of his hits are rifle hits vs ≈ 7% for bots).
    traits: { ...PRESETS.Sniper },
    meta: { windows: ms.length, replays: [...new Set(ms.map((m) => m.replay))].length, depth: o.depth, leaf: o.leaf, cvAcc: o.cv?.acc, cvMajority: o.cv?.majorityAcc, fitAt: new Date().toISOString() },
  };
}

async function main(argv: string[]) {
  const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
  const files = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const depth = Number(opt('depth', '3')), leaf = Number(opt('leaf', '8'));
  const reps = await loadReplays(files.length ? files : userReplayFiles());
  const ms = labelAll(reps, { humansOnly: true });
  if (!ms.length) throw new Error('userproxy: no user windows (no replays with a human player?)');
  const cv = crossValidate(ms, depth, leaf);
  console.log(`user windows ${ms.length} from ${cv.byReplay.length} replays · depth ${depth} leaf ${leaf}`);
  console.log('| held-out replay | windows | tree top-1 | majority class |\n|---|---|---|---|');
  for (const b of cv.byReplay) console.log(`| ${b.replay} | ${b.n} | ${(100 * b.acc).toFixed(1)}% | ${(100 * b.majorityAcc).toFixed(1)}% |`);
  console.log(`| **all (LORO)** | ${cv.n} | **${(100 * cv.acc).toFixed(1)}%** | ${(100 * cv.majorityAcc).toFixed(1)}% |`);
  console.log('recall: ' + Object.entries(cv.recall).map(([k, [h, n]]) => `${k} ${h}/${n}`).join(' · '));
  const model = buildModel(ms, { depth, leaf, bias: Number(opt('bias', '0.4')), difficulty: opt('difficulty', 'hard') as Difficulty, cv });
  console.log(treeText(model.tree));
  const out = opt('out', path.join(LOCAL_DIR, 'userproxy.json'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(model));
  console.log(`model → ${out} (private: keep it out of git; CI: gh secret set USERPROXY_MODEL < ${out})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });

/// <reference types="node" />
/**
 * Rebase a trained champion onto the current hand-tuned bots, so trained params never quietly undo a later retune.
 *
 *   npx tsx scripts/train/rebase-trained.ts --trained <champion.json> --base-hand <hand flat params at the training
 *     commit, JSON> --out src/sim/bots/trained-params.json
 *
 * Keeps an override only where (1) the key is still tunable here, (2) its hand value hasn't changed since the champion
 * was trained (otherwise the new hand value wins), and (3) the trained value differs from the current hand value.
 * Prints every dropped key and why. The rebased file is what must pass the ship gates.
 */
import fs from 'node:fs';
import { HAND_PARAMS, PARAM_RANGES } from '../../src/sim/bots/params';

const args = process.argv.slice(2);
const get = (n: string) => { const i = args.indexOf(`--${n}`); if (i < 0 || !args[i + 1]) throw new Error(`rebase-trained: --${n} is required`); return args[i + 1]; };
const trained = JSON.parse(fs.readFileSync(get('trained'), 'utf8')) as { params?: Record<string, number>; [k: string]: unknown };
const baseHand = JSON.parse(fs.readFileSync(get('base-hand'), 'utf8')) as Record<string, number>;
if (!trained.params) throw new Error('rebase-trained: the trained file has no params');

const kept: Record<string, number> = {};
const dropped: string[] = [];
for (const [k, v] of Object.entries(trained.params)) {
  if (!(k in PARAM_RANGES)) { dropped.push(`${k}: no longer tunable`); continue; }
  const now = HAND_PARAMS[k];
  if (baseHand[k] === undefined) { dropped.push(`${k}: not in the training-time hand params`); continue; }
  if (now !== baseHand[k]) { dropped.push(`${k}: hand default changed since training (${baseHand[k]} -> ${now}); the new hand value wins`); continue; }
  if (v === now) continue;
  kept[k] = v;
}
const out = { ...trained, note: `${trained.note ?? ''} Rebased onto the current hand-tuned params (${Object.keys(kept).length} overrides; ${dropped.length} dropped).`.trim(), params: kept, dropped };
fs.writeFileSync(get('out'), JSON.stringify(out, null, 2) + '\n');
console.log(`rebase-trained: kept ${Object.keys(kept).length} overrides, dropped ${dropped.length}`);
for (const d of dropped) console.log(`  dropped ${d}`);

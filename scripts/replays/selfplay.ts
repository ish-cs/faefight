/// <reference types="node" />
/**
 * Self-play recording: save headless bot matches as replays (inputs for the learning pipeline, or to watch
 * in the game's Replays screen after importing).
 *
 *   npx tsx scripts/replays/selfplay.ts [--games 4] [--players 8] [--difficulty pro] [--max-sec 900] [--seed 1] [--dir .replays/selfplay]
 *
 * The trainer can call recordHeadlessMatch (src/sim/replay/headless.ts) itself and writeReplay() the result.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TICK_HZ } from '../../src/sim/constants';
import type { ReplayHeader } from '../../src/sim/replay/format';
import { recordHeadlessMatch } from '../../src/sim/replay/headless';
import type { Difficulty } from '../../src/sim/types';

/** Write a recording as <dir>/<kind>-<seed>-<id>.faereplay; returns the path. */
export function writeReplay(dir: string, bytes: Uint8Array, header: ReplayHeader): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${header.kind}-${header.setup.seed}-${header.id}.faereplay`);
  fs.writeFileSync(file, bytes);
  return file;
}

async function main(argv: string[]) {
  const arg = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const games = Number(arg('games', '4')), players = Number(arg('players', '8')), maxSec = Number(arg('max-sec', '900'));
  const seed0 = Number(arg('seed', '1')), dir = arg('dir', '.replays/selfplay'), difficulty = arg('difficulty', 'pro') as Difficulty;
  for (let g = 0; g < games; g++) {
    const setup = { players: Array.from({ length: players }, (_, i) => ({ name: `Bot (${difficulty}) ${i + 1}`, isBot: true, difficulty })) };
    const t0 = performance.now();
    const r = await recordHeadlessMatch(setup, seed0 + g, maxSec * TICK_HZ, { tags: { source: 'selfplay.ts' } });
    const file = writeReplay(dir, r.bytes, r.header);
    console.info(`[selfplay] seed ${seed0 + g}: winner ${r.footer.winner ?? '-'} at ${r.footer.duration.toFixed(0)} s, ${(r.bytes.length / 1024).toFixed(0)} KB, ${((performance.now() - t0) / 1000).toFixed(1)} s → ${file}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}

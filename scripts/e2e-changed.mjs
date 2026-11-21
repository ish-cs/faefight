#!/usr/bin/env node
// Runs only the e2e specs that the files changed on this branch can affect.
//
//   pnpm e2e:changed            # diff vs main (git diff --name-only main...HEAD, plus uncommitted changes)
//   pnpm e2e:changed --dry      # just print which specs would run, and why
//   BASE=origin/main pnpm e2e:changed
//   pnpm e2e:changed -- --headed ...   # anything after the script's own flags goes to `playwright test`
//
// A simple path/keyword map. When a changed file isn't covered by the map (or is something everything
// depends on: main.ts, render.ts, the sim loop, config, deps), it falls back to the full suite.
// Docs, unit tests and CI files never trigger e2e. smoke.spec.ts always runs as a sanity check.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const dry = args.includes('--dry');
const passThrough = args.filter((a) => a !== '--dry');
const base = process.env.BASE ?? 'main';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
let changed;
try {
  changed = [...new Set([
    ...git('diff', '--name-only', `${base}...HEAD`),
    ...git('diff', '--name-only', 'HEAD'), // uncommitted (staged + unstaged)
    ...git('ls-files', '--others', '--exclude-standard'),
  ])];
} catch (e) {
  console.error(`e2e:changed: could not diff against '${base}' (${e.message.split('\n')[0]}); running the full suite`);
  changed = null;
}

// Changes here never need e2e.
const IGNORE = [/^docs\//, /^concept\//, /\.md$/, /^tests\/(sim|client|net)\//, /^\.github\//, /^scripts\/(preview\.sh|e2e-changed\.mjs)$/, /^\.vercelignore$/, /^\.gitignore$/, /^public\/.*\.(png|jpe?g|webp)$/];
// Changes here can break anything: run everything.
const FULL = [/^src\/client\/main\.ts$/, /^src\/client\/render\.ts$/, /^src\/client\/worker\.ts$/, /^src\/client\/protocol\.ts$/, /^src\/client\/gameModules\.ts$/,
  /^src\/sim\/(match|matchApi|types|constants|player|physics|map)\.ts$/, /^index\.html$/, /^package\.json$/, /^pnpm-lock\.yaml$/, /^playwright\.config\.ts$/,
  /^vite\.config\.ts$/, /^tsconfig\.json$/, /^tests\/e2e\/predictHelpers\.ts$/];
// File pattern → specs (names without .spec.ts).
const MAP = [
  [/^src\/client\/audio\//, ['audio']],
  [/^src\/(sim\/(building|seal)|client\/(buildAim|world\/(pieces|pieceFx|damageTex)))\.ts$/, ['building']],
  [/^src\/(sim\/lifecycle|client\/(endState|rematch|scoreboard|spectator|announce))\.ts$/, ['endOfMatch']],
  [/^src\/client\/(firstPerson|viewmodel|camera)\.ts$|^src\/client\/characters\//, ['firstPerson', 'guns']],
  [/^src\/(sim\/(combat|gunplay|lagComp)|client\/(gunFx|shotPredict|aim|damageFx))\.ts$/, ['guns', 'lagNet', 'audio']],
  [/^src\/net\//, ['online', 'lagNet', 'endOfMatch', 'lobbySlider', 'lobbyLayout']],
  [/^src\/client\/(predict|interp|snapBuffer|moveQueue|inputAccum|session)\.ts$/, ['movement', 'lagNet', 'online']],
  [/^src\/client\/(lobbyUi|seatSlider)\.ts$/, ['lobbySlider', 'lobbyLayout', 'online']],
  [/^src\/client\/(chatUi|commands)\.ts$/, ['online', 'lobbySlider']],
  [/^src\/client\/(howTo|device|loading|warmup)\.ts$/, ['menuExtras', 'settings']],
  [/^src\/(sim\/movement|client\/(input|keymap))\.ts$/, ['movement', 'settings', 'firstPerson']],
  [/^src\/(sim\/potions|client\/world\/potionSeller)\.ts$/, ['potions']],
  [/^src\/client\/settings\/|^src\/client\/dynRes\.ts$/, ['settings', 'lobbySlider']],
  [/^src\/(sim\/(economy|hotbar|support)|client\/(hud|chipState|icons))\.ts$/, ['shopInfo', 'upgrades', 'potions']],
  [/^src\/client\/style\.css$/, ['shopInfo', 'lobbyLayout', 'menuExtras']],
  [/^src\/sim\/bots\//, ['endOfMatch']],
  [/^src\/client\/(world\/|colors\.ts$)/, []], // visuals only: smoke covers rendering
];

const specs = new Set(['smoke']);
const why = [];
let full = changed === null;
for (const f of changed ?? []) {
  const spec = f.match(/^tests\/e2e\/(\w+)\.spec\.ts$/);
  if (spec) { specs.add(spec[1]); why.push(`${f} → ${spec[1]}`); continue; }
  if (IGNORE.some((r) => r.test(f))) continue;
  if (FULL.some((r) => r.test(f))) { full = true; why.push(`${f} → full suite (core file)`); continue; }
  const hit = MAP.find(([r]) => r.test(f));
  if (!hit) { full = true; why.push(`${f} → full suite (not in the map)`); continue; }
  hit[1].forEach((s) => specs.add(s));
  why.push(`${f} → ${hit[1].join(', ') || 'smoke'}`);
}

const files = full ? [] : [...specs].map((s) => `tests/e2e/${s}.spec.ts`).filter((p) => existsSync(p));
console.log(why.length ? why.join('\n') : `no e2e-relevant changes vs ${base}`);
console.log(full ? 'e2e:changed → full suite' : `e2e:changed → ${files.join(' ')}`);
if (dry) process.exit(0);
const r = spawnSync('pnpm', ['exec', 'playwright', 'test', ...files, ...passThrough], { stdio: 'inherit' });
process.exit(r.status ?? 1);

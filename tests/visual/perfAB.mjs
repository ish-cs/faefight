// A/B perf session under the shared heavy lock: takes /tmp/faefight-heavy.lock, starts one vite dev server per
// source tree, runs perfMatch.mjs for each run spec, then kills the servers and releases the lock (always).
//   node tests/visual/perfAB.mjs <out.txt> '<label>|<dir>|<port>|<extra args, --script=profile.mjs>[|prod]' …
// `prod`: `vite build` that tree into a temp dir and serve it with `vite preview` (bundled, like the real site;
// the dev server is unbundled and slower). The build is a snapshot: later edits to the tree don't leak in.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) { console.error('usage: perfAB.mjs <out> "<label>|<dir>|<port>|<args>" …'); process.exit(2); }
writeFileSync(out, '');
const log = (s) => appendFileSync(out, s + '\n');

// two machine-wide heavy slots (scratchpad heavy.sh): take whichever is free; 15-min-old slots are stale
const SLOTS = ['/tmp/faefight-heavy.lock', '/tmp/faefight-heavy2.lock'];
let LOCK = '';
while (!LOCK) {
  for (const s of SLOTS) {
    try { mkdirSync(s); LOCK = s; break; } catch {
      try { if (Date.now() - statSync(s).mtimeMs > 15 * 60_000 && spawnSync('pgrep', ['-f', 'playwright test|vitest|chrome-headless']).status !== 0) { console.warn(`stale slot ${s} removed`); rmdirSync(s); } } catch { /* gone */ }
    }
  }
  if (!LOCK) await sleep(15_000);
}
log(`lock ${new Date().toISOString()}`);
const servers = new Map();
const release = () => {
  for (const [port, p] of servers) { try { process.kill(-p.pid); } catch { /* exited */ } spawnSync('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill 2>/dev/null`]); }
  try { rmdirSync(LOCK); } catch { /* already gone */ }
  log(`done ${new Date().toISOString()}`);
};
process.on('SIGINT', () => { release(); process.exit(130); });
process.on('SIGTERM', () => { release(); process.exit(143); });
try {
  for (const spec of specs) {
    const [label, dir, port, extra = '', mode = 'dev'] = spec.split('|');
    if (!servers.has(port)) {
      if (mode === 'prod') {
        const outDir = `/tmp/faefight-perf-build-${port}`;
        const b = spawnSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: dir, encoding: 'utf8' });
        if (b.status) { log(`[build ${label} failed] ${b.stderr.slice(-800)}`); continue; }
        servers.set(port, spawn('npx', ['vite', 'preview', '--outDir', outDir, '--port', port, '--strictPort'], { cwd: dir, detached: true, stdio: 'ignore' }));
      } else servers.set(port, spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: dir, detached: true, stdio: 'ignore' }));
      for (let i = 0; i < 90; i++) { try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch { /* not up */ } await sleep(1000); }
    }
    const args = extra.split(' ').filter(Boolean);
    const script = args.find((a) => a.startsWith('--script='))?.slice(9) ?? 'perfMatch.mjs';
    const r = spawnSync('node', [join(here, script), `--label=${label}`, ...args.filter((a) => !a.startsWith('--script='))], { env: { ...process.env, GAME_URL: `http://localhost:${port}` }, encoding: 'utf8', cwd: join(here, '../..') });
    log(r.stdout + (r.status ? `\n[exit ${r.status}] ${r.stderr.slice(-800)}` : ''));
  }
} finally {
  release();
}

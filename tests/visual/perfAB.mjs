// A/B perf session under the shared heavy lock: takes /tmp/faefight-heavy.lock, starts one vite dev server per
// source tree, runs perfMatch.mjs for each run spec, then kills the servers and releases the lock (always).
//   node tests/visual/perfAB.mjs <out.txt> '<label>|<dir>|<port>|<extra perfMatch args>' …
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LOCK = '/tmp/faefight-heavy.lock';
const here = dirname(fileURLToPath(import.meta.url));
const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) { console.error('usage: perfAB.mjs <out> "<label>|<dir>|<port>|<args>" …'); process.exit(2); }
writeFileSync(out, '');
const log = (s) => appendFileSync(out, s + '\n');

for (;;) {
  try { mkdirSync(LOCK); break; } catch {
    try { if (Date.now() - statSync(LOCK).mtimeMs > 25 * 60_000) { console.warn('stale lock removed'); rmdirSync(LOCK); continue; } } catch { /* gone */ }
    await sleep(20_000);
  }
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
    const [label, dir, port, extra = ''] = spec.split('|');
    if (!servers.has(port)) {
      servers.set(port, spawn('npx', ['vite', '--port', port, '--strictPort'], { cwd: dir, detached: true, stdio: 'ignore' }));
      for (let i = 0; i < 90; i++) { try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch { /* not up */ } await sleep(1000); }
    }
    const r = spawnSync('node', [join(here, 'perfMatch.mjs'), `--label=${label}`, ...extra.split(' ').filter(Boolean)], { env: { ...process.env, GAME_URL: `http://localhost:${port}` }, encoding: 'utf8', cwd: join(here, '../..') });
    log(r.stdout + (r.status ? `\n[exit ${r.status}] ${r.stderr.slice(-800)}` : ''));
  }
} finally {
  release();
}

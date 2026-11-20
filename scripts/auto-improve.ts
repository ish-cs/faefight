/// <reference types="node" />
/**
 * Nightly data pull + learning dataset + bug hunting (see scripts/autoimprove/core.ts for the flow).
 * It never trains bots: it rebuilds the dataset the trainer (run elsewhere) reads from
 * .autoimprove/learning/ (see scripts/autoimprove/learning.ts).
 *
 *   pnpm auto-improve [--dry-run] [--no-deploy] [--no-autofix] [--source <dir>] [--api <url>]
 *                     [--repo <dir>] [--state-dir <dir>]
 *
 * Data comes from the deployed admin API (FAEFIGHT_API_BASE + REPLAY_ADMIN_KEY from .env.local) or a
 * local directory laid out like the Blob store (--source). Logs: .autoimprove/logs/<date>.log.
 * Scheduled by launchd: scripts/launchd/com.faefight.autoimprove.plist (see README → Auto-improve).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OPTIONS, runAutoImprove, type RunOptions, type RunResult } from './autoimprove/core';
import { DirSource, HttpSource } from './autoimprove/sources';
import { paths, systemDeps } from './autoimprove/system';

export function loadEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export async function main(argv: string[]): Promise<RunResult> {
  const has = (f: string) => argv.includes(`--${f}`);
  const val = (f: string) => { const i = argv.indexOf(`--${f}`); return i < 0 ? undefined : argv[i + 1]; };

  const repo = path.resolve(val('repo') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const p = paths(repo, val('state-dir') ? path.resolve(val('state-dir')!) : undefined);
  fs.mkdirSync(p.logs, { recursive: true });
  const logFile = path.join(p.logs, `${new Date().toISOString().slice(0, 10)}${has('dry-run') ? '-dry' : ''}.log`);
  const log = (m: string) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    console.log(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    fs.appendFileSync(logFile, line + '\n');
  };

  // Leave the machine usable: lowest scheduling priority.
  try { os.setPriority(19); } catch { /* not permitted: keep going */ }

  const env = { ...loadEnvFile(path.join(repo, '.env.local')), ...process.env };
  const source = val('source')
    ? new DirSource(path.resolve(val('source')!))
    : new HttpSource((val('api') ?? env.FAEFIGHT_API_BASE ?? 'https://faefight.vercel.app').replace(/\/$/, ''), env.REPLAY_ADMIN_KEY ?? '',
      // A protected preview deployment: pass its access cookie (from a share link) in FAEFIGHT_API_COOKIE.
      env.FAEFIGHT_API_COOKIE ? (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: env.FAEFIGHT_API_COOKIE! } }) : fetch);

  const opts: RunOptions = {
    ...DEFAULT_OPTIONS,
    dryRun: has('dry-run'),
    deploy: !has('no-deploy'),
    autofix: !has('no-autofix'),
  };
  log(`auto-improve start: repo ${repo}, source ${source.name}, ${JSON.stringify(opts)}`);
  const deps = systemDeps({ p, source, log });
  const result = await runAutoImprove(deps, opts);
  log(`auto-improve done: ${JSON.stringify(result).slice(0, 1500)}`);
  fs.appendFileSync(path.join(p.logs, 'runs.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n');
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((r) => process.exit(r.outcome === 'abort' ? 1 : 0), (e) => {
    console.error('[auto-improve] fatal', e);
    process.exit(2);
  });
}

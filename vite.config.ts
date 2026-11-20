/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

/**
 * Code version stamped into match recordings (a replay only re-runs exactly on the code that recorded it)
 * and client error reports: VITE_BUILD_ID (auto-improve deploys set it), else the git sha.
 */
function buildId(): string {
  if (process.env.VITE_BUILD_ID) return process.env.VITE_BUILD_ID;
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'; }
  catch { return 'dev'; }
}
const BUILD = JSON.stringify(buildId());

export default defineConfig({
  define: { __FAE_BUILD__: BUILD, __BUILD_ID__: BUILD },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/sim/**/*.test.ts', 'tests/client/**/*.test.ts', 'tests/net/**/*.test.ts', 'tests/api/**/*.test.ts', 'tests/scripts/**/*.test.ts'], testTimeout: 60_000 },
});

import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

/** Build id attached to client error reports: VITE_BUILD_ID (auto-improve deploys set it), else the git sha. */
function buildId(): string {
  if (process.env.VITE_BUILD_ID) return process.env.VITE_BUILD_ID;
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; }
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/sim/**/*.test.ts', 'tests/client/**/*.test.ts', 'tests/net/**/*.test.ts', 'tests/api/**/*.test.ts', 'tests/scripts/**/*.test.ts'], testTimeout: 60_000 },
});

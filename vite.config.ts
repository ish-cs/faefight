import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/sim/**/*.test.ts', 'tests/client/**/*.test.ts', 'tests/net/**/*.test.ts'], testTimeout: 60_000 },
});

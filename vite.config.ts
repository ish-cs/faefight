import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/sim/**/*.test.ts'], testTimeout: 60_000 },
});

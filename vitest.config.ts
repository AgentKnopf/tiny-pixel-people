import { defineConfig } from 'vitest/config';

/**
 * Timing gates (spec v2 §16, AC18) run in their own project, one file at a time and never next to
 * the functional suite, so other workers do not compete for the CPU while they measure.
 */
const PERF = ['test/acceptance/v2/perf-v2.test.ts', 'test/unit/sim/animals-perf.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'default', include: ['test/**/*.test.ts'], exclude: PERF },
      },
      {
        extends: true,
        test: { name: 'perf', include: PERF, fileParallelism: false },
      },
    ],
  },
});

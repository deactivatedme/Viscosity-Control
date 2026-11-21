import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration suites own real resources (a database, a browser); run files one at a time.
    fileParallelism: false,
  },
});

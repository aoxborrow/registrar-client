import { defineConfig, configDefaults } from 'vitest/config';

// Default (unit) test config. Fast, offline, no credentials required.
// Integration tests live in test/integration/*.integration.test.ts and run
// under vitest.integration.config.ts instead.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/types.ts', 'src/**/errors.ts', 'src/index.ts'],
    },
  },
});

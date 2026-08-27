import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // unit tests run under Node by default; browser/edge-env suites can be added later
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/types.ts', 'src/**/errors.ts', 'src/index.ts'],
    },
  },
});

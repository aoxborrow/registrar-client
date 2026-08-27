import { defineConfig } from 'vitest/config';

// Integration test config. Runs only *.integration.test.ts, against registrar
// SANDBOX environments, using credentials from environment variables (loaded
// from .env via the setup file). Tests self-skip when their credentials are
// absent, so this is safe to run with no configuration — it simply runs nothing.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.integration.test.ts'],
    setupFiles: ['test/integration/setup.ts'],
    // network calls to real sandbox APIs need a generous timeout
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // run serially to be gentle on sandbox rate limits
    fileParallelism: false,
    coverage: { enabled: false },
  },
});

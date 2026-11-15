import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/ts/**/*.test.ts'],
    exclude: ['tests/ts/integration/**'],
    testTimeout: 60_000,
  },
});

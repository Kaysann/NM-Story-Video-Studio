import { defineConfig } from 'vitest/config';

// Tests de bout en bout : rendu Remotion réel, FFmpeg réel. Séquentiels et lents.
export default defineConfig({
  test: {
    include: ['tests/ts/integration/**/*.test.ts'],
    testTimeout: 20 * 60_000,
    hookTimeout: 20 * 60_000,
    fileParallelism: false,
  },
});

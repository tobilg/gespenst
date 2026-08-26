import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@gespenst/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@gespenst/core/headless': resolve(import.meta.dirname, 'packages/core/src/core/index.ts'),
      '@gespenst/themes': resolve(import.meta.dirname, 'packages/themes/src/index.ts'),
    },
  },
  test: {
    name: 'node',
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['packages/*/tests/browser/**/*.test.ts'],
    benchmark: {
      include: ['packages/*/tests/**/*.bench.ts'],
    },
  },
});

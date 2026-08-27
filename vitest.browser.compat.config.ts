import { resolve } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: {
    include: ['@xterm/xterm'],
  },
  resolve: {
    alias: {
      '@gespenst/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@gespenst/core/headless': resolve(import.meta.dirname, 'packages/core/src/core/index.ts'),
      '@gespenst/xterm': resolve(import.meta.dirname, 'packages/xterm/src/index.ts'),
    },
  },
  test: {
    name: 'browser-compatibility',
    include: [
      'packages/bashkit/tests/browser/bashkit.test.ts',
      'packages/core/tests/browser/compatibility.test.ts',
      'packages/search/tests/browser/compatibility.test.ts',
      'packages/xterm/tests/browser/compatibility.test.ts',
    ],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});

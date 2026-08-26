import { resolve } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  optimizeDeps: {
    include: ['@xterm/xterm'],
  },
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  resolve: {
    alias: {
      '@gespenst/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@gespenst/core/headless': resolve(import.meta.dirname, 'packages/core/src/core/index.ts'),
    },
  },
  test: {
    name: 'browser',
    include: ['packages/*/tests/browser/**/*.test.ts', 'apps/*/tests/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});

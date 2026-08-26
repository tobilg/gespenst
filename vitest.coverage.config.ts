import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['./vitest.config.ts', './vitest.browser.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        'packages/**/*.d.ts',
        'packages/core/src/index.ts',
        'packages/core/src/types.ts',
        'packages/core/src/core/exports.ts',
        'packages/core/src/worker/terminal-worker.ts',
        'packages/wasmer/src/index.ts',
        'packages/wasmer/src/types.ts',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 78,
        lines: 82,
        'packages/core/src/**': {
          branches: 65,
          lines: 82,
        },
        'packages/clipboard/src/**': {
          branches: 65,
          lines: 90,
        },
        'packages/xterm/src/**': {
          branches: 65,
          lines: 82,
        },
        'packages/wasmer/src/**': {
          branches: 70,
          lines: 85,
        },
        'packages/websocket/src/**': {
          branches: 70,
          lines: 85,
        },
        'packages/react/src/**': {
          branches: 80,
          lines: 90,
        },
        'packages/svelte/src/**': {
          branches: 80,
          lines: 90,
        },
        'packages/vue/src/**': {
          branches: 80,
          lines: 90,
        },
        'packages/web-fonts/src/**': {
          branches: 80,
          lines: 90,
        },
        'packages/search/src/**': {
          branches: 70,
          lines: 90,
        },
        'packages/serialize/src/**': {
          branches: 70,
          lines: 90,
        },
        'packages/web-links/src/**': {
          branches: 70,
          lines: 90,
        },
      },
    },
  },
});

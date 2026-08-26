import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const entries = [
  'index',
  'gespenst-dark',
  'gespenst-light',
  'dracula',
  'catppuccin-mocha',
  'catppuccin-latte',
  'tokyo-night-storm',
  'tokyo-night-day',
  'nord',
  'gruvbox-dark',
  'gruvbox-light',
  'solarized-dark',
  'solarized-light',
] as const;

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    emptyOutDir: true,
    lib: {
      entry: Object.fromEntries(
        entries.map((name) => [name, resolve(import.meta.dirname, `src/${name}.ts`)])
      ),
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@gespenst/core'],
      output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
});

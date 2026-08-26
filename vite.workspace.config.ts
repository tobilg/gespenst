import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export function defineLibraryPackage(directory: string, external: readonly string[] = []) {
  return defineConfig({
    build: {
      target: 'es2022',
      sourcemap: true,
      emptyOutDir: true,
      lib: {
        entry: resolve(directory, 'src/index.ts'),
        formats: ['es'],
        fileName: 'index',
      },
      rollupOptions: {
        external: [...external],
      },
    },
  });
}

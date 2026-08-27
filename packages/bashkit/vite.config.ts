import { defineLibraryPackage } from '../../vite.workspace.config.ts';

export default defineLibraryPackage(import.meta.dirname, [
  '@everruns/bashkit-wasm',
  '@gespenst/core',
]);

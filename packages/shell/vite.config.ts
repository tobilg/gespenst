import { defineLibraryPackage } from '../../vite.workspace.config.ts';

export default defineLibraryPackage(import.meta.dirname, ['@gespenst/bashkit', '@gespenst/core']);

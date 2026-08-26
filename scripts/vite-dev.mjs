import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const vitePackagePath = require.resolve('vite/package.json');
const viteCliPath = resolve(dirname(vitePackagePath), 'bin/vite.js');

// Vite normally terminates from SIGINT, which pnpm reports as a failed
// lifecycle script. Exit successfully so Ctrl-C remains a clean shutdown.
process.once('SIGINT', () => {
  process.exit(0);
});

await import(pathToFileURL(viteCliPath).href);

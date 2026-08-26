import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (target !== 'core') throw new Error(`Unknown package target: ${target ?? '<missing>'}`);

const packageRoot = resolve(root, 'packages/core');
const dist = resolve(packageRoot, 'dist');
await mkdir(dist, { recursive: true });
for (const [source, destination] of [
  ['packages/core/src/assets/ghostty-vt.wasm', 'dist/ghostty-vt.wasm'],
  ['packages/core/src/assets/ghostty-callbacks.wasm', 'dist/ghostty-callbacks.wasm'],
  ['packages/core/src/style.css.d.ts', 'dist/style.css.d.ts'],
  ['LICENSE', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
]) {
  await copyFile(resolve(root, source), resolve(packageRoot, destination));
}

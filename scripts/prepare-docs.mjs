import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetDirectory = resolve(root, 'packages/core/src/assets');
const publicDirectory = resolve(root, 'apps/docs/public');
const assets = [
  {
    source: resolve(assetDirectory, 'ghostty-vt.wasm'),
    destination: 'ghostty-vt.wasm',
  },
  {
    source: resolve(assetDirectory, 'ghostty-callbacks.wasm'),
    destination: 'ghostty-callbacks.wasm',
  },
  {
    source: resolve(assetDirectory, 'ghostty-vt.meta.json'),
    destination: 'ghostty-vt.meta.json',
  },
];

await mkdir(publicDirectory, { recursive: true });
await Promise.all(
  assets.map(({ source, destination }) => copyFile(source, resolve(publicDirectory, destination)))
);

console.log(`Prepared ${assets.length} documentation assets.`);

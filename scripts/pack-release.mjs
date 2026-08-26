import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPublicPackages } from './release-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputIndex = process.argv.indexOf('--output');
const destination = resolve(
  root,
  outputIndex === -1 ? '.release/npm' : (process.argv[outputIndex + 1] ?? '.release/npm')
);
if (!destination.startsWith(`${resolve(root, '.release')}/`)) {
  throw new Error('Release archives must be written below .release/');
}
await rm(destination, { recursive: true, force: true });
const { plan } = await packPublicPackages(root, destination);
console.log(`Packed ${plan.length} release archives in ${destination}`);

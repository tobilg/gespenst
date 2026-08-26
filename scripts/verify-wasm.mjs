import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWasm, sha256 } from './wasm-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'packages/core/src/assets');
const bytes = await readFile(resolve(assets, 'ghostty-vt.wasm'));
const metadata = JSON.parse(await readFile(resolve(assets, 'ghostty-vt.meta.json'), 'utf8'));
const inspected = await inspectWasm(bytes);
const actualHash = sha256(bytes);

if (metadata.sha256 !== actualHash)
  throw new Error('Ghostty WASM checksum does not match metadata');
if (metadata.abiSchema !== inspected.manifest.schema)
  throw new Error('Ghostty ABI schema mismatch');
if (metadata.ghosttyVersion !== inspected.version) throw new Error('Ghostty version mismatch');

console.log(`Verified Ghostty ${inspected.version} (${actualHash})`);

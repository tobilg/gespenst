import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWasm, SOURCE_URL, sha256 } from './wasm-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'packages/core/src/assets');
const wasmPath = resolve(assets, 'ghostty-vt.wasm');
const metadataPath = resolve(assets, 'ghostty-vt.meta.json');

const response = await fetch(SOURCE_URL, { redirect: 'follow' });
if (!response.ok) throw new Error(`failed to download Ghostty: ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
const inspected = await inspectWasm(bytes);
const metadata = {
  source: SOURCE_URL,
  resolvedUrl: response.url.split('?')[0],
  fetchedAt: new Date().toISOString(),
  sha256: sha256(bytes),
  size: bytes.byteLength,
  ghosttyVersion: inspected.version,
  ghosttyCommit: inspected.commit,
  abiSchema: inspected.manifest.schema,
  abi: inspected.manifest.abi,
};

await mkdir(assets, { recursive: true });
await writeFile(wasmPath, bytes);
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Updated Ghostty ${inspected.version} (${bytes.byteLength} bytes, ${metadata.sha256})`);

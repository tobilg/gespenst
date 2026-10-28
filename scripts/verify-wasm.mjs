import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWasm, SIGNATURE_FILE, sha256, verifyMinisign, WASM_FILE } from './wasm-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'packages/core/src/assets');
const bytes = await readFile(resolve(assets, WASM_FILE));
const signatureText = await readFile(resolve(assets, SIGNATURE_FILE), 'utf8');
const metadata = JSON.parse(await readFile(resolve(assets, 'ghostty-vt.meta.json'), 'utf8'));
const signed = verifyMinisign(bytes, signatureText, { fileName: WASM_FILE });
const inspected = await inspectWasm(bytes);
const actualHash = sha256(bytes);

if (metadata.sha256 !== actualHash)
  throw new Error('Ghostty WASM checksum does not match metadata');
if (metadata.size !== bytes.byteLength)
  throw new Error('Ghostty WASM size does not match metadata');
if (metadata.abiSchema !== inspected.manifest.schema)
  throw new Error('Ghostty ABI schema mismatch');
if (metadata.ghosttyVersion !== inspected.version) throw new Error('Ghostty version mismatch');
if (!/^[0-9a-f]{40}$/u.test(metadata.ghosttyCommit ?? ''))
  throw new Error('Ghostty WASM metadata must record the full source commit');

console.log(
  `Verified Ghostty ${inspected.version} at ${metadata.ghosttyCommit.slice(0, 9)} ` +
    `(${actualHash}, signed ${signed.signedAt})`
);

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffGhosttyBuilds,
  formatBuildDiff,
  inspectWasm,
  RELEASE_API_URL,
  REQUIRED_EXPORTS,
  readGhosttyBuild,
  resolveTipRelease,
  SIGNATURE_FILE,
  SOURCE_URL,
  sha256,
  verifyMinisign,
  WASM_FILE,
} from './wasm-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'packages/core/src/assets');
const wasmPath = resolve(assets, WASM_FILE);
const signaturePath = resolve(assets, SIGNATURE_FILE);
const metadataPath = resolve(assets, 'ghostty-vt.meta.json');

async function fetchRelease() {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  // Unauthenticated API calls are rate limited per IP; CI can pass its token.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(RELEASE_API_URL, { headers });
  if (!response.ok) throw new Error(`failed to read the Ghostty tip release: ${response.status}`);
  return resolveTipRelease(await response.json());
}

async function download(asset) {
  const response = await fetch(asset.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`failed to download ${asset.name}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asset.size || sha256(bytes) !== asset.sha256) {
    throw new Error(
      `${asset.name} does not match the release digest; the tip release may have been ` +
        'republished during the download, so run the update again'
    );
  }
  return { bytes, resolvedUrl: response.url.split('?')[0] };
}

async function readPrevious() {
  try {
    return await readFile(wasmPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const release = await fetchRelease();
const [wasm, signature] = await Promise.all([download(release.wasm), download(release.signature)]);
const signatureText = new TextDecoder().decode(signature.bytes);
const signed = verifyMinisign(wasm.bytes, signatureText, { fileName: WASM_FILE });
const inspected = await inspectWasm(wasm.bytes);
if (inspected.commit && !release.commit.startsWith(inspected.commit)) {
  throw new Error(`Ghostty reports commit ${inspected.commit}, but tip is ${release.commit}`);
}

const previousBytes = await readPrevious();
if (previousBytes) {
  const diff = diffGhosttyBuilds(
    await readGhosttyBuild(previousBytes),
    await readGhosttyBuild(wasm.bytes)
  );
  console.log(formatBuildDiff(diff));
  // Required exports are declared with fixed signatures in packages/core/src/core/exports.ts.
  const breaking = diff.signaturesChanged.filter(({ name }) => REQUIRED_EXPORTS.includes(name));
  if (breaking.length > 0) {
    throw new Error(
      `required export signatures changed: ${breaking.map(({ name }) => name).join(', ')}; ` +
        'update packages/core/src/core/exports.ts before vendoring this build'
    );
  }
}

const metadata = {
  source: SOURCE_URL,
  resolvedUrl: wasm.resolvedUrl,
  fetchedAt: new Date().toISOString(),
  sha256: release.wasm.sha256,
  size: wasm.bytes.byteLength,
  ghosttyVersion: inspected.version,
  ghosttyCommit: release.commit,
  abiSchema: inspected.manifest.schema,
  abi: inspected.manifest.abi,
};

await mkdir(assets, { recursive: true });
await writeFile(wasmPath, wasm.bytes);
await writeFile(signaturePath, signature.bytes);
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(
  `Updated Ghostty ${inspected.version} at ${release.commit.slice(0, 9)} ` +
    `(${wasm.bytes.byteLength} bytes, ${metadata.sha256}, signed ${signed.signedAt})`
);

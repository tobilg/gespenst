import { createHash, createPublicKey, verify } from 'node:crypto';
import requiredExportKinds from '../packages/core/src/core/required-exports.json' with {
  type: 'json',
};

export const WASM_FILE = 'ghostty-vt.wasm';
export const SIGNATURE_FILE = `${WASM_FILE}.minisig`;
export const SOURCE_URL = `https://github.com/ghostty-org/ghostty/releases/download/tip/${WASM_FILE}`;
export const SIGNATURE_URL = `${SOURCE_URL}.minisig`;
export const RELEASE_API_URL = 'https://api.github.com/repos/ghostty-org/ghostty/releases/tags/tip';

/** Ghostty's release signing key, published in PACKAGING.md of the Ghostty repository. */
export const GHOSTTY_MINISIGN_PUBLIC_KEY =
  'RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV';

export const REQUIRED_EXPORTS = Object.freeze(Object.keys(requiredExportKinds));

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;

function readCString(memory, pointer) {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end === bytes.length) throw new Error('unterminated string in WASM memory');
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

/** Reads the ABI manifest and export signatures of a Ghostty build without validating them. */
export async function readGhosttyBuild(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes);
  const { memory, ghostty_type_json: typeJson } = instance.exports;
  return {
    manifest: JSON.parse(readCString(memory, typeJson())),
    signatures: exportSignatures(bytes),
  };
}

export async function inspectWasm(bytes) {
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new Error(`ghostty-vt.wasm must have no imports; found ${imports.length}`);
  }

  const moduleExports = new Map(
    WebAssembly.Module.exports(module).map((item) => [item.name, item.kind])
  );
  const invalid = Object.entries(requiredExportKinds).flatMap(([name, expected]) => {
    const actual = moduleExports.get(name);
    if (!actual) return [`${name} is missing (expected ${expected})`];
    return actual === expected ? [] : [`${name} is ${actual} (expected ${expected})`];
  });
  if (invalid.length > 0) throw new Error(`invalid WASM exports: ${invalid.join('; ')}`);

  const instance = await WebAssembly.instantiate(module);
  const exports = instance.exports;
  const invalidInstances = Object.entries(requiredExportKinds).flatMap(([name, expected]) => {
    const actual = instanceExportKind(exports[name]);
    if (!actual) return [`${name} is missing (expected ${expected})`];
    return actual === expected ? [] : [`${name} is ${actual} (expected ${expected})`];
  });
  if (invalidInstances.length > 0) {
    throw new Error(`invalid instantiated WASM exports: ${invalidInstances.join('; ')}`);
  }
  const memory = exports.memory;
  const manifest = JSON.parse(readCString(memory, exports.ghostty_type_json()));
  if (manifest.schema !== 1) throw new Error(`unsupported Ghostty ABI schema: ${manifest.schema}`);
  if (manifest.abi?.target !== 'wasm32' || manifest.abi?.endian !== 'little') {
    throw new Error('expected a little-endian wasm32 Ghostty ABI');
  }

  const versionValue = exports.ghostty_wasm_alloc(8);
  if (!versionValue) throw new Error('failed to allocate build-info output');
  try {
    const result = exports.ghostty_build_info(5, versionValue);
    if (result !== 0) throw new Error(`ghostty_build_info failed: ${result}`);
    const view = new DataView(memory.buffer);
    const pointer = view.getUint32(versionValue, true);
    const length = view.getUint32(versionValue + 4, true);
    const version = new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length));
    const commit = version.includes('+') ? version.slice(version.lastIndexOf('+') + 1) : null;
    return { module, manifest, version, commit };
  } finally {
    exports.ghostty_wasm_free(versionValue, 8);
  }
}

function instanceExportKind(value) {
  if (typeof value === 'function') return 'function';
  if (value instanceof WebAssembly.Memory) return 'memory';
  if (value instanceof WebAssembly.Table) return 'table';
  if (value instanceof WebAssembly.Global) return 'global';
  return value === undefined ? undefined : typeof value;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verifies a prehashed minisign signature and its signed trusted comment.
 *
 * Ghostty signs release assets with `minisign -H`: Ed25519 over the BLAKE2b-512 digest of the
 * file, plus a second signature over the trusted comment that names the signed file.
 */
export function verifyMinisign(
  bytes,
  signatureText,
  { fileName, publicKey = GHOSTTY_MINISIGN_PUBLIC_KEY }
) {
  const key = Buffer.from(publicKey, 'base64');
  if (key.length !== 42 || key.toString('latin1', 0, 2) !== 'Ed') {
    throw new Error('invalid minisign public key');
  }
  const lines = signatureText.split('\n').map((line) => line.replace(/\r$/u, ''));
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[2]?.startsWith('trusted comment: ')) {
    throw new Error('malformed minisign signature');
  }
  const signature = Buffer.from(lines[1] ?? '', 'base64');
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64');
  if (signature.length !== 74 || globalSignature.length !== 64) {
    throw new Error('malformed minisign signature');
  }
  if (signature.toString('latin1', 0, 2) !== 'ED') {
    throw new Error('expected a prehashed (ED) minisign signature');
  }
  if (!signature.subarray(2, 10).equals(key.subarray(2, 10))) {
    throw new Error('minisign signature was made with a different key');
  }

  const verifier = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, key.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const value = signature.subarray(10);
  const digest = createHash('blake2b512').update(bytes).digest();
  if (!verify(null, digest, verifier, value)) {
    throw new Error(`minisign signature does not match ${fileName}`);
  }
  const trustedComment = lines[2].slice('trusted comment: '.length);
  const signedComment = Buffer.concat([value, Buffer.from(trustedComment, 'utf8')]);
  if (!verify(null, signedComment, verifier, globalSignature)) {
    throw new Error('minisign trusted comment signature is invalid');
  }

  const fields = new Map(
    trustedComment.split('\t').map((field) => {
      const separator = field.indexOf(':');
      return separator < 0 ? [field, ''] : [field.slice(0, separator), field.slice(separator + 1)];
    })
  );
  if (fields.get('file') !== fileName) {
    throw new Error(`minisign signature is for ${fields.get('file') ?? 'an unnamed file'}`);
  }
  const timestamp = Number(fields.get('timestamp'));
  return {
    trustedComment,
    signedAt: Number.isSafeInteger(timestamp) ? new Date(timestamp * 1000).toISOString() : null,
  };
}

/** Validates the GitHub API response for Ghostty's `tip` release and selects the WASM assets. */
export function resolveTipRelease(release) {
  if (release?.tag_name !== 'tip') throw new Error('expected the Ghostty tip release');
  if (!COMMIT_PATTERN.test(release.target_commitish ?? '')) {
    throw new Error(`tip release has no full commit SHA: ${release.target_commitish}`);
  }
  const asset = (name, url) => {
    const matches = (release.assets ?? []).filter((item) => item.name === name);
    if (matches.length !== 1) throw new Error(`tip release must contain exactly one ${name}`);
    const [item] = matches;
    if (item.state !== 'uploaded') throw new Error(`${name} is not fully uploaded (${item.state})`);
    if (item.browser_download_url !== url) {
      throw new Error(`${name} has an unexpected download URL: ${item.browser_download_url}`);
    }
    const digest = DIGEST_PATTERN.exec(item.digest ?? '');
    if (!digest) throw new Error(`${name} has no SHA-256 digest in the release metadata`);
    if (!Number.isSafeInteger(item.size) || item.size <= 0) {
      throw new Error(`${name} has an invalid size`);
    }
    return { name, url, size: item.size, sha256: digest[1], updatedAt: item.updated_at };
  };
  return {
    commit: release.target_commitish,
    wasm: asset(WASM_FILE, SOURCE_URL),
    signature: asset(SIGNATURE_FILE, SIGNATURE_URL),
  };
}

const VALUE_TYPES = new Map([
  [0x7f, 'i32'],
  [0x7e, 'i64'],
  [0x7d, 'f32'],
  [0x7c, 'f64'],
  [0x7b, 'v128'],
  [0x70, 'funcref'],
  [0x6f, 'externref'],
]);
const EXPORT_KINDS = ['function', 'table', 'memory', 'global'];

/**
 * Reads every export from a WASM binary. Function exports map to their `(params) -> (results)`
 * signature and other exports to their kind, so both kind and signature changes are visible.
 */
export function exportSignatures(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (!magic.every((value, index) => view[index] === value)) {
    throw new Error('not a version 1 WASM binary');
  }
  let offset = magic.length;
  const readU32 = () => {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = view[offset++];
      if (byte === undefined) throw new Error('truncated WASM binary');
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
    }
    throw new Error('invalid LEB128 value in WASM binary');
  };
  const readValueType = () => {
    const type = VALUE_TYPES.get(view[offset++]);
    if (!type) throw new Error('unsupported WASM value type');
    return type;
  };

  const types = [];
  const functionTypes = [];
  const signatures = new Map();
  while (offset < view.length) {
    const section = view[offset++];
    const size = readU32();
    const end = offset + size;
    if (end > view.length) throw new Error('truncated WASM section');
    if (section === 1) {
      for (let count = readU32(); count > 0; count -= 1) {
        if (view[offset++] !== 0x60) throw new Error('unsupported WASM type section entry');
        const params = Array.from({ length: readU32() }, readValueType);
        const results = Array.from({ length: readU32() }, readValueType);
        types.push(`(${params.join(', ')}) -> (${results.join(', ')})`);
      }
    } else if (section === 2) {
      // Function indexes below would shift with imported functions; Ghostty imports nothing.
      if (readU32() !== 0) throw new Error('ghostty-vt.wasm must have no imports');
    } else if (section === 3) {
      for (let count = readU32(); count > 0; count -= 1) functionTypes.push(readU32());
    } else if (section === 7) {
      for (let count = readU32(); count > 0; count -= 1) {
        const length = readU32();
        const name = new TextDecoder().decode(view.subarray(offset, offset + length));
        offset += length;
        const kind = view[offset++];
        const index = readU32();
        const signature = kind === 0 ? types[functionTypes[index]] : EXPORT_KINDS[kind];
        if (!signature) throw new Error(`cannot resolve the type of export ${name}`);
        signatures.set(name, signature);
      }
    }
    offset = end;
  }
  return signatures;
}

function describeTypeChanges(before, after) {
  const changes = [];
  for (const property of ['kind', 'size', 'align']) {
    if (before[property] !== after[property]) {
      changes.push(`${property} ${before[property]} -> ${after[property]}`);
    }
  }
  const field = (value) => `${value.type}@${value.offset}/${value.size}`;
  for (const [name, value] of Object.entries(before.fields ?? {})) {
    const next = after.fields?.[name];
    if (!next) changes.push(`-field ${name}`);
    else if (field(value) !== field(next)) {
      changes.push(`field ${name} ${field(value)} -> ${field(next)}`);
    }
  }
  for (const name of Object.keys(after.fields ?? {})) {
    if (!before.fields?.[name]) changes.push(`+field ${name}`);
  }
  for (const [name, value] of Object.entries(before.values ?? {})) {
    const next = after.values?.[name];
    if (next === undefined) changes.push(`-value ${name}`);
    else if (next !== value) changes.push(`value ${name} ${value} -> ${next}`);
  }
  for (const [name, value] of Object.entries(after.values ?? {})) {
    if (before.values?.[name] === undefined) changes.push(`+value ${name}=${value}`);
  }
  if (JSON.stringify(before.bits ?? null) !== JSON.stringify(after.bits ?? null)) {
    changes.push('bit fields changed');
  }
  return changes;
}

/** Compares two builds read with {@link readGhosttyBuild}. */
export function diffGhosttyBuilds(previous, next) {
  const sortedKeys = (map) => [...map.keys()].sort();
  const previousTypes = previous.manifest.types ?? {};
  const nextTypes = next.manifest.types ?? {};
  return {
    exportsAdded: sortedKeys(next.signatures).filter((name) => !previous.signatures.has(name)),
    exportsRemoved: sortedKeys(previous.signatures).filter((name) => !next.signatures.has(name)),
    signaturesChanged: sortedKeys(previous.signatures)
      .filter((name) => next.signatures.has(name))
      .filter((name) => previous.signatures.get(name) !== next.signatures.get(name))
      .map((name) => ({
        name,
        before: previous.signatures.get(name),
        after: next.signatures.get(name),
      })),
    typesAdded: Object.keys(nextTypes)
      .filter((name) => !(name in previousTypes))
      .sort(),
    typesRemoved: Object.keys(previousTypes)
      .filter((name) => !(name in nextTypes))
      .sort(),
    typesChanged: Object.keys(previousTypes)
      .filter((name) => name in nextTypes)
      .sort()
      .map((name) => ({ name, changes: describeTypeChanges(previousTypes[name], nextTypes[name]) }))
      .filter(({ changes }) => changes.length > 0),
  };
}

/** Formats a {@link diffGhosttyBuilds} result for review in the terminal. */
export function formatBuildDiff(diff) {
  const lines = [];
  const section = (title, items) => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length}):`, ...items.map((item) => `  ${item}`));
  };
  section('Removed exports', diff.exportsRemoved);
  section(
    'Changed export signatures',
    diff.signaturesChanged.map(({ name, before, after }) => `${name}: ${before} -> ${after}`)
  );
  section('Added exports', diff.exportsAdded);
  section('Removed ABI types', diff.typesRemoved);
  section(
    'Changed ABI types',
    diff.typesChanged.map(({ name, changes }) => `${name}: ${changes.join('; ')}`)
  );
  section('Added ABI types', diff.typesAdded);
  return lines.length > 0 ? lines.join('\n') : 'No export or ABI changes.';
}

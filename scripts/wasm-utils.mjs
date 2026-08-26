import { createHash } from 'node:crypto';
import requiredExportKinds from '../packages/core/src/core/required-exports.json' with {
  type: 'json',
};

export const SOURCE_URL =
  'https://github.com/ghostty-org/ghostty/releases/download/tip/ghostty-vt.wasm';

export const REQUIRED_EXPORTS = Object.freeze(Object.keys(requiredExportKinds));

function readCString(memory, pointer) {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end === bytes.length) throw new Error('unterminated string in WASM memory');
  return new TextDecoder().decode(bytes.subarray(pointer, end));
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

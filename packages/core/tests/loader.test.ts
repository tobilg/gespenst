import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_GHOSTTY_EXPORTS,
  validateInstanceExports,
  validateModuleExportDescriptors,
} from '../src/core/required-exports.js';

describe('Ghostty WASM export validation', () => {
  it('accepts the complete vendored nightly module and instance', async () => {
    const bytes = await readFile(new URL('../src/assets/ghostty-vt.wasm', import.meta.url));
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const module = await WebAssembly.compile(copy);
    const instance = await WebAssembly.instantiate(module);
    expect(validateModuleExportDescriptors(WebAssembly.Module.exports(module))).toEqual([]);
    expect(validateInstanceExports(instance.exports)).toEqual([]);
  });

  it('reports every missing and mistyped module export', () => {
    const descriptors = REQUIRED_GHOSTTY_EXPORTS.map(([name, kind]) => ({ name, kind }));
    descriptors.splice(
      descriptors.findIndex(({ name }) => name === 'ghostty_terminal_reset'),
      1
    );
    const memory = descriptors.find((entry) => entry.name === 'memory');
    if (!memory) throw new Error('Expected the memory descriptor');
    memory.kind = 'function';

    expect(validateModuleExportDescriptors(descriptors)).toEqual([
      'memory is function (expected memory)',
      'ghostty_terminal_reset is missing (expected function)',
    ]);
  });

  it('rejects wrong instantiated export values', () => {
    const exports = Object.fromEntries(
      REQUIRED_GHOSTTY_EXPORTS.map(([name, kind]) => {
        if (kind === 'memory') return [name, new WebAssembly.Memory({ initial: 1 })];
        if (kind === 'table')
          return [name, new WebAssembly.Table({ element: 'anyfunc', initial: 1 })];
        return [name, () => undefined];
      })
    ) as WebAssembly.Exports;
    exports.ghostty_paste_encode = new WebAssembly.Global({ value: 'i32' }, 0);
    expect(validateInstanceExports(exports)).toContain(
      'ghostty_paste_encode is global (expected function)'
    );
  });
});

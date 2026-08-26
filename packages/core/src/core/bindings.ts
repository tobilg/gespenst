import type { GhosttyAbi } from './abi.js';
import type { GhosttyExports } from './exports.js';

/** Error returned by a failed Ghostty WASM operation. */
export class GhosttyError extends Error {
  /** Stable error name. */
  override readonly name = 'GhosttyError';

  /** Creates an error from an operation label and Ghostty result code. */
  constructor(message: string, result: number) {
    super(`${message} (Ghostty result ${result})`);
    this.result = result;
  }

  /** Numeric Ghostty result code. */
  readonly result: number;
}

export class Allocation {
  private readonly bindings: GhosttyBindings;
  readonly pointer: number;
  readonly length: number;

  constructor(bindings: GhosttyBindings, pointer: number, length: number) {
    this.bindings = bindings;
    this.pointer = pointer;
    this.length = length;
  }

  get view(): DataView {
    return new DataView(this.bindings.exports.memory.buffer, this.pointer, this.length);
  }

  get bytes(): Uint8Array {
    return new Uint8Array(this.bindings.exports.memory.buffer, this.pointer, this.length);
  }

  free(): void {
    this.bindings.exports.ghostty_wasm_free(this.pointer, this.length);
  }
}

export class GhosttyBindings {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  readonly exports: GhosttyExports;
  readonly abi: GhosttyAbi;

  constructor(exports: GhosttyExports, abi: GhosttyAbi) {
    this.exports = exports;
    this.abi = abi;
  }

  check(result: number, operation: string): void {
    if (result !== 0) throw new GhosttyError(operation, result);
  }

  alloc(length: number): Allocation {
    const pointer = this.exports.ghostty_wasm_alloc(length);
    if (!pointer) throw new GhosttyError(`Failed to allocate ${length} bytes`, -1);
    return new Allocation(this, pointer, length);
  }

  allocType(typeName: string, sized = false): Allocation {
    const allocation = this.alloc(this.abi.size(typeName));
    allocation.bytes.fill(0);
    if (sized) allocation.view.setUint32(0, allocation.length, true);
    return allocation;
  }

  createHandle(operation: string, create: (slot: number) => number): number {
    const slot = this.exports.ghostty_wasm_alloc_opaque();
    if (!slot) throw new GhosttyError(`Failed to allocate ${operation} handle slot`, -1);
    try {
      this.check(create(slot), operation);
      const handle = this.exports.ghostty_wasm_take_opaque(slot);
      if (!handle) throw new GhosttyError(`${operation} returned a null handle`, -1);
      return handle;
    } finally {
      this.exports.ghostty_wasm_free_opaque(slot);
    }
  }

  withBytes<T>(value: string | Uint8Array, use: (pointer: number, length: number) => T): T {
    const bytes = typeof value === 'string' ? this.encoder.encode(value) : value;
    if (bytes.byteLength === 0) return use(0, 0);
    const allocation = this.alloc(bytes.byteLength);
    try {
      allocation.bytes.set(bytes);
      return use(allocation.pointer, bytes.byteLength);
    } finally {
      allocation.free();
    }
  }

  readString(pointer: number, length: number): string {
    if (!pointer || length === 0) return '';
    return this.decoder.decode(new Uint8Array(this.exports.memory.buffer, pointer, length));
  }

  readStringStruct(pointer: number, typeName = 'GhosttyString'): string {
    const view = new DataView(this.exports.memory.buffer);
    const data = view.getUint32(pointer + this.abi.field(typeName, 'ptr').offset, true);
    const length = view.getUint32(pointer + this.abi.field(typeName, 'len').offset, true);
    return this.readString(data, length);
  }

  copyBytes(pointer: number, length: number): Uint8Array {
    if (!pointer || length === 0) return new Uint8Array();
    return new Uint8Array(this.exports.memory.buffer, pointer, length).slice();
  }

  readColor(pointer: number): { r: number; g: number; b: number } {
    const bytes = new Uint8Array(this.exports.memory.buffer, pointer, 3);
    return { r: bytes[0] ?? 0, g: bytes[1] ?? 0, b: bytes[2] ?? 0 };
  }

  writeColor(pointer: number, color: { r: number; g: number; b: number }): void {
    const bytes = new Uint8Array(this.exports.memory.buffer, pointer, 3);
    bytes[0] = color.r;
    bytes[1] = color.g;
    bytes[2] = color.b;
  }
}

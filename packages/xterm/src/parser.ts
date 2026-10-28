import type { IDisposable, IFunctionIdentifier, IParser } from '@xterm/xterm';

type Params = (number | number[])[];
type CsiHandler = (params: Params) => boolean | Promise<boolean>;
type DcsHandler = (data: string, params: Params) => boolean | Promise<boolean>;
type EscHandler = () => boolean | Promise<boolean>;
type OscHandler = (data: string) => boolean | Promise<boolean>;

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const MAX_PENDING_BYTES = 10 * 1024 * 1024;
const NO_BYTES = new Uint8Array(0);

export class ParserApi implements IParser {
  private readonly csi = new Map<string, CsiHandler[]>();
  private readonly dcs = new Map<string, DcsHandler[]>();
  private readonly esc = new Map<string, EscHandler[]>();
  private readonly osc = new Map<number, OscHandler[]>();
  /** Final bytes with a registered CSI handler, so other CSI sequences skip parameter parsing. */
  private readonly csiFinals = new Set<number>();
  private pending: Uint8Array = NO_BYTES;
  private readonly decoder = new TextDecoder();

  get active(): boolean {
    return this.csi.size + this.dcs.size + this.esc.size + this.osc.size > 0;
  }

  registerCsiHandler(id: IFunctionIdentifier, callback: CsiHandler): IDisposable {
    return register(this.csi, identifier(id), callback, () => {
      this.csiFinals.clear();
      for (const key of this.csi.keys()) this.csiFinals.add(key.charCodeAt(key.length - 1));
    });
  }

  registerDcsHandler(id: IFunctionIdentifier, callback: DcsHandler): IDisposable {
    return register(this.dcs, identifier(id), callback);
  }

  registerEscHandler(id: IFunctionIdentifier, callback: EscHandler): IDisposable {
    return register(this.esc, identifier(id), callback);
  }

  registerOscHandler(ident: number, callback: OscHandler): IDisposable {
    if (!Number.isInteger(ident) || ident < 0) throw new Error('OSC identifier must be positive');
    return register(this.osc, ident, callback);
  }

  /**
   * Removes the sequences a registered handler consumes. Returns `data` itself when nothing was
   * removed or held back, and keeps an incomplete trailing sequence for the next call.
   */
  async process(data: Uint8Array): Promise<Uint8Array> {
    if (!this.active) return data;
    let input = data;
    if (this.pending.byteLength > 0) {
      input = new Uint8Array(this.pending.byteLength + data.byteLength);
      input.set(this.pending);
      input.set(data, this.pending.byteLength);
      this.pending = NO_BYTES;
    }
    const parts: Uint8Array[] = [];
    let changed = input !== data;
    // Start of the input not yet copied to `parts`.
    let kept = 0;
    let offset = 0;
    while (offset < input.length) {
      const start = input.indexOf(ESC, offset);
      if (start === -1) break;
      const parsed = this.parseSequence(input, start);
      if (!parsed) {
        if (input.length - start > MAX_PENDING_BYTES)
          throw new Error('Custom parser sequence exceeded 10 MiB');
        this.pending = input.slice(start);
        parts.push(input.subarray(kept, start));
        kept = input.length;
        changed = true;
        break;
      }
      offset = parsed.end;
      if (parsed.kind === 'skip') continue;
      let handled: boolean;
      if (parsed.kind === 'csi') {
        const result = invoke(this.csi.get(parsed.key), parsed.params);
        handled = typeof result === 'boolean' ? result : await result;
      } else if (parsed.kind === 'dcs') {
        const result = invoke(this.dcs.get(parsed.key), parsed.data, parsed.params);
        handled = typeof result === 'boolean' ? result : await result;
      } else if (parsed.kind === 'osc') {
        const result = invoke(this.osc.get(parsed.ident), parsed.data);
        handled = typeof result === 'boolean' ? result : await result;
      } else {
        const result = invoke(this.esc.get(parsed.key));
        handled = typeof result === 'boolean' ? result : await result;
      }
      if (!handled) continue;
      parts.push(input.subarray(kept, start));
      kept = parsed.end;
      changed = true;
    }
    if (!changed) return data;
    if (kept < input.length) parts.push(input.subarray(kept));
    return concatBytes(parts);
  }

  /** Parses the sequence at `start`, or returns `null` when it is incomplete. */
  private parseSequence(input: Uint8Array, start: number): ParsedSequence | null {
    const introducer = input[start + 1];
    if (introducer === undefined) return null;
    if (introducer === 0x5d) {
      const terminator = oscTerminator(input, start + 2);
      if (terminator === -1) return null;
      const end = terminator + (input[terminator] === BEL ? 1 : 2);
      if (this.osc.size === 0) return { kind: 'skip', end };
      const separator = input.indexOf(0x3b, start + 2);
      const hasData = separator !== -1 && separator < terminator;
      const ident = Number.parseInt(ascii(input, start + 2, hasData ? separator : terminator), 10);
      return {
        kind: 'osc',
        ident: Number.isFinite(ident) ? ident : 0,
        data: hasData ? this.decoder.decode(input.subarray(separator + 1, terminator)) : '',
        end,
      };
    }
    if (introducer === 0x5b) {
      const final = findFinal(input, start + 2);
      if (final === -1) return null;
      if (!this.csiFinals.has(input[final] as number)) return { kind: 'skip', end: final + 1 };
      const simple = simpleParams(input, start + 2, final);
      if (simple) {
        const key = String.fromCharCode(input[final] as number);
        if (!this.csi.has(key)) return { kind: 'skip', end: final + 1 };
        return { kind: 'csi', key, params: simple, end: final + 1 };
      }
      const parts = splitHeader(ascii(input, start + 2, final));
      const key = parts.prefix + parts.intermediates + String.fromCharCode(input[final] as number);
      if (!this.csi.has(key)) return { kind: 'skip', end: final + 1 };
      return { kind: 'csi', key, params: parseParams(parts.params), end: final + 1 };
    }
    if (introducer === 0x50) {
      const final = findFinal(input, start + 2);
      if (final === -1) return null;
      const st = stringTerminator(input, final + 1);
      if (st === -1) return null;
      if (this.dcs.size === 0) return { kind: 'skip', end: st + 2 };
      const parts = splitHeader(ascii(input, start + 2, final));
      return {
        kind: 'dcs',
        key: parts.prefix + parts.intermediates + String.fromCharCode(input[final] as number),
        params: parseParams(parts.params),
        data: this.decoder.decode(input.subarray(final + 1, st)),
        end: st + 2,
      };
    }
    let final = start + 1;
    while (
      final < input.length &&
      (input[final] as number) >= 0x20 &&
      (input[final] as number) <= 0x2f
    )
      final += 1;
    if (final >= input.length) return null;
    if (this.esc.size === 0) return { kind: 'skip', end: final + 1 };
    return { kind: 'esc', key: ascii(input, start + 1, final + 1), end: final + 1 };
  }
}

type ParsedSequence =
  | { kind: 'skip'; end: number }
  | { kind: 'csi'; key: string; params: Params; end: number }
  | { kind: 'dcs'; key: string; params: Params; data: string; end: number }
  | { kind: 'osc'; ident: number; data: string; end: number }
  | { kind: 'esc'; key: string; end: number };

/** Index of the BEL or `ESC \` that ends an OSC payload starting at `from`, or -1. */
function oscTerminator(input: Uint8Array, from: number): number {
  const bel = input.indexOf(BEL, from);
  const st = stringTerminator(input, from);
  return bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
}

/** Index of the first `ESC \` at or after `from`, or -1. */
function stringTerminator(input: Uint8Array, from: number): number {
  for (let index = input.indexOf(ESC, from); index !== -1; index = input.indexOf(ESC, index + 1)) {
    if (input[index + 1] === BACKSLASH) return index;
  }
  return -1;
}

/**
 * Parses a CSI header made only of digits and `;`, the common case for SGR and cursor movement,
 * without building strings. Returns `null` for any other header.
 */
function simpleParams(input: Uint8Array, start: number, end: number): number[] | null {
  const params: number[] = [];
  let value = 0;
  for (let index = start; index < end; index += 1) {
    const code = input[index] as number;
    if (code === 0x3b) {
      params.push(value);
      value = 0;
    } else if (code >= 0x30 && code <= 0x39) value = value * 10 + code - 0x30;
    else return null;
  }
  params.push(value);
  return params;
}

/** Decodes a sequence header, which is ASCII by construction. */
function ascii(input: Uint8Array, start: number, end: number): string {
  let value = '';
  for (let index = start; index < end; index += 1)
    value += String.fromCharCode(input[index] as number);
  return value;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function findFinal(input: Uint8Array, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    const code = input[index] as number;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function splitHeader(header: string): {
  prefix: string;
  params: string;
  intermediates: string;
} {
  let start = 0;
  let prefix = '';
  if (header.charCodeAt(0) >= 0x3c && header.charCodeAt(0) <= 0x3f) {
    prefix = header[0] ?? '';
    start = 1;
  }
  let intermediateStart = header.length;
  for (let index = start; index < header.length; index += 1) {
    const code = header.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) {
      intermediateStart = index;
      break;
    }
  }
  return {
    prefix,
    params: header.slice(start, intermediateStart),
    intermediates: header.slice(intermediateStart),
  };
}

function parseParams(value: string): Params {
  if (!value) return [0];
  return value.split(';').map((part) => {
    if (part.includes(':')) return part.split(':').map((item) => Number.parseInt(item || '0', 10));
    return Number.parseInt(part || '0', 10);
  });
}

function identifier(id: IFunctionIdentifier): string {
  return (id.prefix ?? '') + (id.intermediates ?? '') + id.final;
}

function register<K, H>(map: Map<K, H[]>, key: K, handler: H, changed?: () => void): IDisposable {
  const handlers = map.get(key) ?? [];
  handlers.push(handler);
  map.set(key, handlers);
  changed?.();
  return {
    dispose() {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
      if (handlers.length === 0 && map.get(key) === handlers) {
        map.delete(key);
        changed?.();
      }
    },
  };
}

function invoke<Args extends readonly unknown[]>(
  handlers: readonly ((...args: Args) => boolean | Promise<boolean>)[] | undefined,
  ...args: Args
): boolean | Promise<boolean> {
  if (!handlers) return false;
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    const result = handlers[index]?.(...args) ?? false;
    if (typeof result === 'boolean') {
      if (result) return true;
      continue;
    }
    return continueInvocation(result, handlers, index - 1, args);
  }
  return false;
}

async function continueInvocation<Args extends readonly unknown[]>(
  result: Promise<boolean>,
  handlers: readonly ((...args: Args) => boolean | Promise<boolean>)[],
  index: number,
  args: Args
): Promise<boolean> {
  if (await result) return true;
  for (let current = index; current >= 0; current -= 1) {
    if (await handlers[current]?.(...args)) return true;
  }
  return false;
}

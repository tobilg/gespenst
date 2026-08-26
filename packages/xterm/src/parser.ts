import type { IDisposable, IFunctionIdentifier, IParser } from '@xterm/xterm';

type Params = (number | number[])[];
type CsiHandler = (params: Params) => boolean | Promise<boolean>;
type DcsHandler = (data: string, params: Params) => boolean | Promise<boolean>;
type EscHandler = () => boolean | Promise<boolean>;
type OscHandler = (data: string) => boolean | Promise<boolean>;

export class ParserApi implements IParser {
  private readonly csi = new Map<string, CsiHandler[]>();
  private readonly dcs = new Map<string, DcsHandler[]>();
  private readonly esc = new Map<string, EscHandler[]>();
  private readonly osc = new Map<number, OscHandler[]>();
  private pending = '';
  private readonly decoder = new TextDecoder();

  get active(): boolean {
    return this.csi.size + this.dcs.size + this.esc.size + this.osc.size > 0;
  }

  registerCsiHandler(id: IFunctionIdentifier, callback: CsiHandler): IDisposable {
    return register(this.csi, identifier(id), callback);
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

  async process(data: string | Uint8Array): Promise<string | Uint8Array> {
    if (!this.active) return data;
    const input =
      this.pending +
      (typeof data === 'string' ? data : this.decoder.decode(data, { stream: true }));
    this.pending = '';
    let output = '';
    let offset = 0;
    while (offset < input.length) {
      const start = input.indexOf('\x1b', offset);
      if (start === -1) {
        output += input.slice(offset);
        break;
      }
      output += input.slice(offset, start);
      const parsed = parseSequence(input, start);
      if (!parsed) {
        this.pending = input.slice(start);
        if (this.pending.length > 10 * 1024 * 1024)
          throw new Error('Custom parser sequence exceeded 10 MiB');
        break;
      }
      let handled = false;
      if (parsed.kind === 'csi') {
        handled = await invoke(this.csi.get(parsed.key), parsed.params);
      } else if (parsed.kind === 'dcs') {
        handled = await invoke(this.dcs.get(parsed.key), parsed.data, parsed.params);
      } else if (parsed.kind === 'osc') {
        handled = await invoke(this.osc.get(parsed.ident), parsed.data);
      } else {
        handled = await invoke(this.esc.get(parsed.key));
      }
      if (!handled) output += input.slice(start, parsed.end);
      offset = parsed.end;
    }
    return output;
  }
}

type ParsedSequence =
  | { kind: 'csi'; key: string; params: Params; end: number }
  | { kind: 'dcs'; key: string; params: Params; data: string; end: number }
  | { kind: 'osc'; ident: number; data: string; end: number }
  | { kind: 'esc'; key: string; end: number };

function parseSequence(input: string, start: number): ParsedSequence | null {
  const introducer = input[start + 1];
  if (introducer === undefined) return null;
  if (introducer === ']') {
    const bel = input.indexOf('\x07', start + 2);
    const st = input.indexOf('\x1b\\', start + 2);
    const terminator = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
    if (terminator === -1) return null;
    const separator = input.indexOf(';', start + 2);
    const identEnd = separator === -1 || separator > terminator ? terminator : separator;
    const ident = Number.parseInt(input.slice(start + 2, identEnd), 10);
    return {
      kind: 'osc',
      ident: Number.isFinite(ident) ? ident : 0,
      data:
        separator === -1 || separator > terminator ? '' : input.slice(separator + 1, terminator),
      end: terminator + (input[terminator] === '\x07' ? 1 : 2),
    };
  }
  if (introducer === '[') {
    const final = findFinal(input, start + 2);
    if (final === -1) return null;
    const header = input.slice(start + 2, final);
    const parts = splitHeader(header);
    return {
      kind: 'csi',
      key: parts.prefix + parts.intermediates + input[final],
      params: parseParams(parts.params),
      end: final + 1,
    };
  }
  if (introducer === 'P') {
    const final = findFinal(input, start + 2);
    if (final === -1) return null;
    const st = input.indexOf('\x1b\\', final + 1);
    if (st === -1) return null;
    const parts = splitHeader(input.slice(start + 2, final));
    return {
      kind: 'dcs',
      key: parts.prefix + parts.intermediates + input[final],
      params: parseParams(parts.params),
      data: input.slice(final + 1, st),
      end: st + 2,
    };
  }
  let final = start + 1;
  while (final < input.length && input.charCodeAt(final) >= 0x20 && input.charCodeAt(final) <= 0x2f)
    final += 1;
  if (final >= input.length) return null;
  return { kind: 'esc', key: input.slice(start + 1, final + 1), end: final + 1 };
}

function findFinal(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
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

function register<K, H>(map: Map<K, H[]>, key: K, handler: H): IDisposable {
  const handlers = map.get(key) ?? [];
  handlers.push(handler);
  map.set(key, handlers);
  return {
    dispose() {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
      if (handlers.length === 0) map.delete(key);
    },
  };
}

async function invoke<Args extends readonly unknown[]>(
  handlers: readonly ((...args: Args) => boolean | Promise<boolean>)[] | undefined,
  ...args: Args
): Promise<boolean> {
  if (!handlers) return false;
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    if (await handlers[index]?.(...args)) return true;
  }
  return false;
}

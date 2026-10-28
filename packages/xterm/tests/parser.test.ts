import { describe, expect, it, vi } from 'vitest';
import { ParserApi } from '../src/parser';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Runs `value` through the parser and decodes what it passes on. */
async function processed(parser: ParserApi, value: string | Uint8Array): Promise<string> {
  return decoder.decode(
    await parser.process(typeof value === 'string' ? encoder.encode(value) : value)
  );
}

describe('xterm parser compatibility', () => {
  it('handles CSI, DCS, OSC, and ESC sequences while preserving unhandled data', async () => {
    const parser = new ParserApi();
    const csi = vi.fn(async () => true);
    const dcs = vi.fn(() => true);
    const osc = vi.fn(() => true);
    const esc = vi.fn(() => true);
    parser.registerCsiHandler({ prefix: '?', final: 'm' }, csi);
    parser.registerDcsHandler({ final: 'q' }, dcs);
    parser.registerOscHandler(8, osc);
    parser.registerEscHandler({ intermediates: '(', final: '0' }, esc);

    const output = await processed(
      parser,
      `before\x1b[?1;2:3mafter\x1bP1;2qpayload\x1b\\\x1b]8;link\x07\x1b(0!\x1b[31m`
    );

    expect(output).toBe('beforeafter!\x1b[31m');
    expect(csi).toHaveBeenCalledWith([1, [2, 3]]);
    expect(dcs).toHaveBeenCalledWith('payload', [1, 2]);
    expect(osc).toHaveBeenCalledWith('link');
    expect(esc).toHaveBeenCalledOnce();
  });

  it('buffers split strings and bytes and removes disposed handlers', async () => {
    const parser = new ParserApi();
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);
    const one = parser.registerCsiHandler({ final: 'm' }, first);
    const two = parser.registerCsiHandler({ final: 'm' }, second);

    expect(await processed(parser, 'a\x1b[3')).toBe('a');
    expect(await processed(parser, '1mb')).toBe('b');
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    two.dispose();
    expect(await processed(parser, '\x1b[32m')).toBe('\x1b[32m');
    expect(first).toHaveBeenCalledOnce();
    one.dispose();
    expect(parser.active).toBe(false);
    expect(await processed(parser, 'plain')).toBe('plain');
  });

  it('validates OSC identifiers and bounds incomplete custom sequences', async () => {
    const parser = new ParserApi();
    expect(() => parser.registerOscHandler(-1, () => true)).toThrow('positive');
    expect(() => parser.registerOscHandler(1.5, () => true)).toThrow('positive');
    parser.registerOscHandler(1, () => true);

    const oversized = `\x1b]${'x'.repeat(10 * 1024 * 1024)}`;
    await expect(processed(parser, oversized)).rejects.toThrow('exceeded 10 MiB');
  });

  it('preserves byte identity when registered handlers cannot match the chunk', async () => {
    const parser = new ParserApi();
    parser.registerOscHandler(8, () => true);
    const bytes = new TextEncoder().encode('plain UTF-8: 👻');

    expect(await parser.process(bytes)).toBe(bytes);
  });

  it('passes split UTF-8 through after a handled byte sequence', async () => {
    const parser = new ParserApi();
    parser.registerCsiHandler({ final: 'm' }, () => true);
    const bytes = encoder.encode('\x1b[31m👻');

    const first = await parser.process(bytes.subarray(0, bytes.length - 2));
    const second = await parser.process(bytes.subarray(bytes.length - 2));
    expect(decoder.decode(new Uint8Array([...first, ...second]))).toBe('👻');
  });

  it('returns the input when only sequences without handlers occur', async () => {
    const parser = new ParserApi();
    const csi = vi.fn(() => false);
    parser.registerCsiHandler({ final: 'm' }, csi);
    const bytes = encoder.encode('a\x1b[2K\x1b[?25l\x1b]0;title\x07\x1bP1q\x1b\\\x1b(0\x1b[1;32mb');

    expect(await parser.process(bytes)).toBe(bytes);
    expect(csi).toHaveBeenCalledExactlyOnceWith([1, 32]);
  });

  it('matches CSI handlers by prefix and intermediates as well as the final byte', async () => {
    const parser = new ParserApi();
    const plain = vi.fn(() => true);
    const spaced = vi.fn(() => true);
    parser.registerCsiHandler({ final: 'q' }, plain);
    parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, spaced);

    expect(await processed(parser, '\x1b[?1q|\x1b[2 q|\x1b[3q')).toBe('\x1b[?1q||');
    expect(spaced).toHaveBeenCalledWith([2]);
    expect(plain).toHaveBeenCalledWith([3]);
  });
});

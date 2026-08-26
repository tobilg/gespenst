import { describe, expect, it, vi } from 'vitest';
import { ParserApi } from '../src/parser';

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

    const output = await parser.process(
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

    expect(await parser.process(new TextEncoder().encode('a\x1b[3'))).toBe('a');
    expect(await parser.process(new TextEncoder().encode('1mb'))).toBe('b');
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    two.dispose();
    expect(await parser.process('\x1b[32m')).toBe('\x1b[32m');
    expect(first).toHaveBeenCalledOnce();
    one.dispose();
    expect(parser.active).toBe(false);
    expect(await parser.process('plain')).toBe('plain');
  });

  it('validates OSC identifiers and bounds incomplete custom sequences', async () => {
    const parser = new ParserApi();
    expect(() => parser.registerOscHandler(-1, () => true)).toThrow('positive');
    expect(() => parser.registerOscHandler(1.5, () => true)).toThrow('positive');
    parser.registerOscHandler(1, () => true);

    const oversized = `\x1b]${'x'.repeat(10 * 1024 * 1024)}`;
    await expect(parser.process(oversized)).rejects.toThrow('exceeded 10 MiB');
  });
});

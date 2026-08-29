import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '../../src';

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  document.body.replaceChildren();
});

describe('xterm browser compatibility', () => {
  it('opens, writes, exposes buffer state, resizes, and disposes', async () => {
    const host = document.createElement('div');
    host.style.width = '480px';
    host.style.height = '240px';
    document.body.append(host);
    const terminal = new Terminal({ cols: 32, rows: 6 });
    terminals.push(terminal);
    terminal.open(host);
    await terminal.ready;
    await new Promise<void>((resolve) =>
      terminal.write('\x1b[34mxterm compatibility\x1b[0m \u754c\ud83d\ude42', resolve)
    );

    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain(
      'xterm compatibility \u754c\ud83d\ude42'
    );
    terminal.resize(40, 8);
    expect(terminal.cols).toBe(40);
    expect(terminal.rows).toBe(8);

    terminal.dispose();
    terminals.pop();
    expect(host.childElementCount).toBe(0);
  });

  it('applies ordinary writes from the core render delta without rereading the viewport', async () => {
    const host = document.createElement('div');
    host.style.width = '480px';
    host.style.height = '240px';
    document.body.append(host);
    const terminal = new Terminal({ cols: 32, rows: 6, scrollback: 0 });
    terminals.push(terminal);
    terminal.open(host);
    await terminal.ready;
    await new Promise<void>((resolve) => terminal.write('first', resolve));

    const native = await terminal.native;
    const original = native.readBuffer.bind(native);
    let reads = 0;
    const ranges: unknown[] = [];
    native.readBuffer = async (...args) => {
      reads += 1;
      ranges.push(args[0]);
      return original(...args);
    };
    await new Promise<void>((resolve) => terminal.write(' second', resolve));

    expect({ reads, ranges }).toEqual({ reads: 0, ranges: [] });
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('first second');
  });

  it('applies a full-viewport bulk write without falling back to a buffer read', async () => {
    const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 0 });
    terminals.push(terminal);
    await new Promise<void>((resolve) => terminal.write('seed', resolve));
    const native = await terminal.native;
    const original = native.readBuffer.bind(native);
    let reads = 0;
    const ranges: unknown[] = [];
    native.readBuffer = async (...args) => {
      reads += 1;
      ranges.push(args[0]);
      return original(...args);
    };
    const row = `\x1b[38;2;80;180;130mcolored output\x1b[0m ${'x'.repeat(58)}\r\n`;

    await new Promise<void>((resolve) => terminal.write(row.repeat(220), resolve));

    expect({ reads, ranges }).toEqual({ reads: 0, ranges: [] });
  });

  it('retains incremental scrollback from render deltas without full-buffer reads', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, scrollback: 20 });
    terminals.push(terminal);
    await new Promise<void>((resolve) => terminal.write('one\r\ntwo\r\nthree', resolve));

    const native = await terminal.native;
    const original = native.readBuffer.bind(native);
    let reads = 0;
    const ranges: unknown[] = [];
    native.readBuffer = async (...args) => {
      reads += 1;
      ranges.push(args[0]);
      return original(...args);
    };
    await new Promise<void>((resolve) => terminal.write('\r\nfour', resolve));

    expect(reads).toBe(0);
    expect(ranges).toEqual([]);
    expect(terminal.buffer.active.baseY).toBe(1);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('one');
    expect(terminal.buffer.active.getLine(3)?.translateToString(true)).toBe('four');
  });

  it('retains every row from a bulk scrollback write without authoritative rereads', async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, scrollback: 2_000 });
    terminals.push(terminal);
    await new Promise<void>((resolve) => terminal.write('line-0', resolve));
    const native = await terminal.native;
    const original = native.readBuffer.bind(native);
    let reads = 0;
    native.readBuffer = async (...args) => {
      reads += 1;
      return original(...args);
    };
    const output = Array.from({ length: 1_000 }, (_, index) => `\r\nline-${index + 1}`).join('');

    await new Promise<void>((resolve) => terminal.write(output, resolve));

    expect(reads).toBe(0);
    expect(terminal.buffer.active.length).toBe(1_001);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('line-0');
    expect(terminal.buffer.active.getLine(1_000)?.translateToString(true)).toBe('line-1000');
  });

  it('coalesces writes that arrive across adjacent microtasks into one native frame', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, scrollback: 0 });
    terminals.push(terminal);
    terminal.write('ready');
    await terminal.ready;
    await new Promise<void>((resolve) => terminal.write('', resolve));

    const native = await terminal.native;
    const key = Symbol.for('@gespenst/core/xterm-compatibility');
    const bridge = (
      native as unknown as Record<
        symbol,
        {
          writeAsync(data: Uint8Array, owned: boolean, boundaries: Uint32Array): Promise<unknown>;
        }
      >
    )[key];
    if (!bridge) throw new Error('Core compatibility bridge is unavailable');
    const original = bridge.writeAsync.bind(bridge);
    let writes = 0;
    bridge.writeAsync = async (data, owned, boundaries) => {
      writes += 1;
      return original(data, owned, boundaries);
    };

    const first = new Promise<void>((resolve) => terminal.write(' a', resolve));
    await Promise.resolve();
    const second = new Promise<void>((resolve) => terminal.write(' b', resolve));
    await Promise.all([first, second]);

    expect(writes).toBe(1);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('ready a b');
  });
});

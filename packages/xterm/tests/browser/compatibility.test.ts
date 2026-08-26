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
});

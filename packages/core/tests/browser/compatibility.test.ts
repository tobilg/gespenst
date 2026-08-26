import { afterEach, describe, expect, it } from 'vitest';
import { createTerminal, type GespenstTerminal } from '../../src';

const terminals: GespenstTerminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  document.body.replaceChildren();
});

describe('core browser compatibility', () => {
  it('loads default WASM, parses Unicode, accepts input, resizes, and disposes', async () => {
    const host = document.createElement('div');
    host.style.width = '480px';
    host.style.height = '240px';
    document.body.append(host);
    const terminal = await createTerminal({
      container: host,
      cols: 32,
      rows: 6,
      renderer: 'canvas2d',
      accessibility: 'full',
    });
    terminals.push(terminal);

    const input = new Promise<string>((resolve) => {
      terminal.on('input', ({ data }) => resolve(new TextDecoder().decode(data)));
    });
    await terminal.writeAsync('\x1b[32mcompatibility\x1b[0m \u754c\ud83d\ude42');
    terminal.sendText('typed');

    expect((await terminal.readViewport()).viewportRows[0]?.text).toContain(
      'compatibility \u754c\ud83d\ude42'
    );
    await expect(input).resolves.toBe('typed');
    terminal.resize(40, 8);
    expect(terminal.geometry).toMatchObject({ cols: 40, rows: 8 });
    expect(terminal.element.querySelector('.gespenst__a11y')?.textContent).toContain(
      'compatibility'
    );

    terminal.dispose();
    terminals.pop();
    expect(host.childElementCount).toBe(0);
  });
});

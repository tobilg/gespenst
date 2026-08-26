import { AttachAddon } from '@xterm/addon-attach';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '../../src/index';

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function host(): HTMLDivElement {
  const element = document.createElement('div');
  element.style.width = '480px';
  element.style.height = '240px';
  document.body.append(element);
  return element;
}

describe('@gespenst/xterm official addon compatibility', () => {
  it('runs the pinned Fit, Search, Serialize, WebLinks, and Attach addons', async () => {
    const terminal = new Terminal({
      cols: 30,
      rows: 5,
      scrollback: 20,
      allowProposedApi: true,
    });
    terminals.push(terminal);
    terminal.open(host());
    await terminal.ready;

    const fit = new FitAddon();
    const search = new SearchAddon();
    const serialize = new SerializeAddon();
    const activated = vi.fn();
    const webLinks = new WebLinksAddon((_event: MouseEvent, uri: string) => activated(uri));
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(serialize);
    terminal.loadAddon(webLinks);

    await new Promise<void>((resolve) =>
      terminal.write(
        '\x1b[31mhello addon\x1b[0m https://example.com\r\n\x1b[?2004hsecond line',
        resolve
      )
    );
    expect(fit.proposeDimensions()).toMatchObject({
      rows: expect.any(Number),
      cols: expect.any(Number),
    });
    fit.fit();
    expect(search.findNext('hello')).toBe(true);
    expect(terminal.getSelectionPosition()).toMatchObject({ start: { x: 0, y: 0 } });
    expect(serialize.serialize()).toContain('hello addon');
    expect(serialize.serialize()).toContain('\x1b[?2004h');
    expect(serialize.serializeAsHTML()).toContain('hello addon');

    const bounds = terminal.element?.getBoundingClientRect();
    if (!bounds) throw new Error('Expected an open terminal');
    const metrics = terminal._core._renderService.dimensions.css.cell;
    const urlColumn = 'hello addon '.length;
    const pointer = {
      bubbles: true,
      clientX: bounds.left + (urlColumn + 0.5) * metrics.width,
      clientY: bounds.top + metrics.height / 2,
    };
    terminal.element?.dispatchEvent(new MouseEvent('mousemove', pointer));
    await Promise.resolve();
    await Promise.resolve();
    terminal.element?.dispatchEvent(new MouseEvent('mousedown', pointer));
    terminal.element?.dispatchEvent(new MouseEvent('mouseup', pointer));
    expect(activated).toHaveBeenCalledWith('https://example.com');

    const socket = new EventTarget() as EventTarget & {
      binaryType: BinaryType;
      readonly readyState: number;
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
    };
    Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN });
    const send = vi.fn();
    socket.send = send;
    const attach = new AttachAddon(socket as unknown as WebSocket);
    terminal.loadAddon(attach);
    socket.dispatchEvent(new MessageEvent('message', { data: ' attached' }));
    // Attach writes synchronously from the message listener. An empty write after dispatch is an
    // ordering fence which completes only after the attached payload has reached Ghostty.
    await new Promise<void>((resolve) => terminal.write('', resolve));
    terminal.input('outbound');
    expect(send).toHaveBeenCalledWith('outbound');
    const bufferText = Array.from({ length: terminal.buffer.active.length }, (_, line) =>
      terminal.buffer.active.getLine(line)?.translateToString(true)
    ).join('\n');
    expect(bufferText).toContain('attached');
  });
});

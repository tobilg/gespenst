import type { IBuffer } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type GespenstXtermRuntimeOptions,
  Terminal,
  toXtermTheme,
  XtermCompatibilityError,
} from '../../../xterm/src';
import { createTerminal, type GespenstTerminal } from '../../src';
import {
  XTERM_COMPATIBILITY_BRIDGE,
  type XtermBufferSource,
  type XtermCompatibilityBridge,
} from '../../src/internal/xterm-compatibility.js';

const nativeTerminals: GespenstTerminal[] = [];
const compatibleTerminals: Terminal[] = [];

function bufferSource(native: GespenstTerminal): XtermBufferSource {
  const source = (native as unknown as Record<symbol, XtermCompatibilityBridge | undefined>)[
    XTERM_COMPATIBILITY_BRIDGE
  ]?.buffer;
  if (!source) throw new Error('Core buffer source is unavailable');
  return source;
}

/** Every retained row of `buffer` as trimmed text. */
function lines(buffer: IBuffer): string[] {
  return Array.from(
    { length: buffer.length },
    (_, y) => buffer.getLine(y)?.translateToString(true) ?? '<missing>'
  );
}

afterEach(() => {
  for (const terminal of compatibleTerminals.splice(0)) terminal.dispose();
  for (const terminal of nativeTerminals.splice(0)) terminal.dispose();
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

describe('@gespenst/xterm', () => {
  it('queues writes behind async startup and mirrors the stable buffer API', async () => {
    const terminal = new Terminal({ cols: 30, rows: 6 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    const parsed = new Promise<void>((resolve) => terminal.onWriteParsed(resolve));
    const callback = new Promise<void>((resolve) => {
      terminal.write('hello xterm\x1b[?2004h', resolve);
    });

    await terminal.ready;
    await callback;
    await parsed;

    expect(terminal.cols).toBe(30);
    expect(terminal.rows).toBe(6);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('hello xterm');
    expect(terminal.modes.bracketedPasteMode).toBe(true);
    expect(terminal.element?.classList.contains('xterm')).toBe(true);
    expect(terminal.textarea).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('preserves scrollback rows and split mode sequences in buffer views', async () => {
    const terminal = new Terminal({ cols: 8, rows: 2, scrollback: 10 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    await new Promise<void>((resolve) => terminal.write('one\r\ntwo\r\nthree\x1b[?20', resolve));
    await new Promise<void>((resolve) => terminal.write('04h', resolve));

    expect(terminal.buffer.active.length).toBe(3);
    expect(terminal.buffer.active.baseY).toBe(1);
    expect(terminal.buffer.active.viewportY).toBe(1);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('one');
    expect(terminal.modes.bracketedPasteMode).toBe(true);
  });

  it('applies convertEol to string and byte writes across chunk boundaries', async () => {
    const terminal = new Terminal({ cols: 8, rows: 3, convertEol: true });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;

    await new Promise<void>((resolve) => terminal.write('abc\nx\r', resolve));
    await new Promise<void>((resolve) => terminal.write(new Uint8Array([0x0a, 0x71]), resolve));
    await new Promise<void>((resolve) => terminal.write(new Uint8Array([0x0a, 0x7a]), resolve));

    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('abc');
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('x');
    expect(terminal.buffer.active.getLine(2)?.translateToString(true)).toBe('q');
  });

  it('coalesces same-turn writes while preserving callback order', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const native = await terminal.native;
    const write = vi.spyOn(bufferSource(native), 'write');
    const callbacks: number[] = [];

    terminal.write('one', () => callbacks.push(1));
    terminal.write(' two', () => callbacks.push(2));
    await new Promise<void>((resolve) =>
      terminal.write(' three', () => {
        callbacks.push(3);
        resolve();
      })
    );

    expect(write).toHaveBeenCalledOnce();
    expect(callbacks).toEqual([1, 2, 3]);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('one two three');
  });

  it('implements xterm lifecycle, navigation, selection, decoration, and addon APIs', async () => {
    const terminal = new Terminal({
      cols: 10,
      rows: 4,
      scrollback: 10,
      allowProposedApi: true,
    });
    compatibleTerminals.push(terminal);
    const parent = host();
    terminal.open(parent);
    expect(() => terminal.open(parent)).not.toThrow();
    await terminal.ready;
    const native = await terminal.native;
    const resize = vi.spyOn(native, 'resize');
    const addonDispose = vi.fn();
    const addon = { activate: vi.fn(), dispose: addonDispose };
    terminal.loadAddon(addon);
    expect(addon.activate).toHaveBeenCalledWith(terminal);

    const renders: Array<{ start: number; end: number }> = [];
    terminal.onRender((range) => renders.push(range));
    terminal.refresh(-10, 99);
    terminal.clearTextureAtlas();
    expect(renders).toEqual([
      { start: 0, end: terminal.rows - 1 },
      { start: 0, end: terminal.rows - 1 },
    ]);

    terminal.focus();
    terminal.blur();
    terminal.resize(12, 5);
    terminal.scrollLines(-1);
    terminal.scrollPages(2);
    terminal.scrollToLine(3);
    terminal.scrollToTop();
    terminal.scrollToBottom();
    terminal.paste('pasted');
    terminal.select(1, 0, 3);
    expect(terminal.getSelectionPosition()).toEqual({
      start: { x: 1, y: 0 },
      end: { x: 4, y: 0 },
    });
    terminal.selectLines(2, 1);
    terminal.selectAll();
    expect(terminal.hasSelection()).toBe(false);
    expect(terminal.getSelection()).toBe('');
    terminal.clearSelection();

    const marker = terminal.registerMarker();
    expect(terminal.markers).toContain(marker);
    const decoration = terminal.registerDecoration({
      marker,
      anchor: 'right',
      x: 1,
      width: 2,
      height: 2,
      layer: 'top',
      backgroundColor: '#123456',
      foregroundColor: '#abcdef',
      overviewRulerOptions: { color: '#123456', position: 'left' },
    });
    expect(decoration?.element?.style.right).not.toBe('');
    expect(decoration?.isDisposed).toBe(false);
    expect(() => terminal.registerDecoration({ marker, x: -1 })).toThrow(/positive integers/u);

    expect(terminal.unicode.versions).toEqual(['ghostty']);
    expect(terminal.unicode.activeVersion).toBe('ghostty');
    terminal.unicode.activeVersion = 'ghostty';
    expect(() => {
      terminal.unicode.activeVersion = 'other';
    }).toThrow(XtermCompatibilityError);
    expect(() =>
      terminal.unicode.register({
        version: 'test',
        wcwidth: () => 1,
        charProperties: () => 1,
      })
    ).toThrow(XtermCompatibilityError);
    expect(() => terminal.registerCharacterJoiner(() => [])).toThrow(XtermCompatibilityError);
    expect(() => terminal.deregisterCharacterJoiner(1)).toThrow(XtermCompatibilityError);

    terminal.options = {
      theme: { foreground: '#eeeeee' },
      fontFamily: 'Test Mono',
      fontSize: 16,
      fontWeight: 500,
      fontWeightBold: 800,
      letterSpacing: 1,
      lineHeight: 1.2,
    };
    terminal.attachCustomWheelEventHandler(() => false);
    terminal.element?.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1 })
    );
    terminal.element?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Shift' })
    );
    terminal.element?.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Shift' })
    );
    terminal.clear();
    await new Promise<void>((resolve) => terminal.writeln(new Uint8Array([0x6f, 0x6b]), resolve));
    expect(resize).toHaveBeenCalledWith(12, 5);

    terminal.reset();
    await new Promise<void>((resolve) => terminal.write('done', resolve));
    expect(marker.isDisposed).toBe(true);
    terminal.dispose();
    expect(addonDispose).toHaveBeenCalledOnce();
  });

  it('shifts and disposes markers as retained rows are pruned', async () => {
    // Wide rows make Ghostty's pages small, so history is pruned a page at a time.
    const terminal = new Terminal({ cols: 300, rows: 4, scrollback: 300, allowProposedApi: true });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    let next = 0;
    const output = (count: number) =>
      new Promise<void>((resolve) =>
        terminal.write(Array.from({ length: count }, () => `\r\nline ${next++}`).join(''), resolve)
      );
    // Start past the first pruned page, so the marker moves before its own page is pruned.
    await output(1000);
    const marker = terminal.registerMarker();
    const marked = terminal.buffer.active.getLine(marker.line)?.translateToString(true);
    const disposed = vi.fn();
    marker.onDispose(disposed);

    let shifted = false;
    while (!marker.isDisposed && next < 10_000) {
      const before = marker.line;
      await output(37);
      if (marker.isDisposed) break;
      shifted ||= marker.line < before;
      expect(terminal.buffer.active.getLine(marker.line)?.translateToString(true)).toBe(marked);
    }
    expect(shifted).toBe(true);
    expect(marker.line).toBe(-1);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('keeps normal-buffer markers and rows across a full-screen app', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3, scrollback: 50, allowProposedApi: true });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    await write('one\r\ntwo\r\nthree\r\nfour');
    const marker = terminal.registerMarker(-1);
    const normal = lines(terminal.buffer.normal);

    await write('\x1b[?1049h\x1b[Hfull screen');
    expect(terminal.buffer.active.type).toBe('alternate');
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('full screen');
    expect(lines(terminal.buffer.normal)).toEqual(normal);
    expect(terminal.markers).toEqual([]);

    await write('\x1b[?1049l');
    expect(terminal.buffer.active.type).toBe('normal');
    expect(lines(terminal.buffer.active)).toEqual(normal);
    expect(lines(terminal.buffer.alternate)).toEqual(['', '', '']);
    expect(marker.isDisposed).toBe(false);
    expect(terminal.buffer.active.getLine(marker.line)?.translateToString(true)).toBe('three');
  });

  it('mirrors native reads after streaming output and shows native writes', async () => {
    const terminal = new Terminal({ cols: 40, rows: 6, scrollback: 100 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const native = await terminal.native;
    for (let chunk = 0; chunk < 20; chunk += 1) {
      terminal.write(
        `\x1b[3${chunk % 8}mchunk ${chunk}\x1b[0m ` +
          Array.from({ length: 9 }, (_, line) => `${chunk}.${line} 😀 e\u0301`).join('\r\n') +
          '\r\n'
      );
    }
    await new Promise<void>((resolve) => terminal.write('', resolve));
    const snapshot = await native.readBuffer({ start: 0, end: terminal.buffer.active.length });
    expect(lines(terminal.buffer.active)).toEqual(snapshot.rows.map((row) => row.text.trimEnd()));

    native.write('\r\nfrom native');
    const last = terminal.buffer.active.length - 1;
    expect(terminal.buffer.active.getLine(last)?.translateToString(true)).toBe('from native');
  });

  it('parses before write callbacks run and paints afterwards', async () => {
    const terminal = new Terminal({ cols: 20, rows: 3 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    await waitFrames(2);
    const events: string[] = [];
    terminal.onRender(() => events.push('render'));
    await new Promise<void>((resolve) =>
      terminal.write('ordered', () => {
        events.push(`callback:${terminal.buffer.active.getLine(0)?.translateToString(true)}`);
        resolve();
      })
    );
    await waitFrames(2);
    expect(events).toEqual(['callback:ordered', 'render']);
  });

  it('rejects worker execution, which would make buffer reads asynchronous', () => {
    for (const worker of ['dedicated', 'shared'] as const) {
      expect(() => new Terminal({ gespenst: { worker } as GespenstXtermRuntimeOptions })).toThrow(
        XtermCompatibilityError
      );
    }
    const terminal = new Terminal({
      gespenst: { worker: false } as GespenstXtermRuntimeOptions,
    });
    compatibleTerminals.push(terminal);
  });

  it('reports a scroll that is painted in the same frame as a scrolling write', async () => {
    // The main-thread backend paints the write and the scroll below in one animation frame.
    const terminal = new Terminal({ cols: 8, rows: 2, scrollback: 10 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const positions: number[] = [];
    const viewports: number[] = [];
    terminal.onScroll((position) => {
      positions.push(position);
      viewports.push(terminal.buffer.active.viewportY);
    });

    await new Promise<void>((resolve) => terminal.write('one\r\ntwo\r\nthree', resolve));
    expect(positions).toEqual([1]);

    const top = new Promise<void>((resolve) => {
      const subscription = terminal.onScroll(() => {
        subscription.dispose();
        resolve();
      });
    });
    terminal.scrollToTop();
    await top;
    expect(positions).toEqual([1, 0]);
    expect(viewports).toEqual(positions);
  });

  it('exposes rows changed outside the viewport when writes complete', async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, scrollback: 10 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    const line = (y: number) => terminal.buffer.active.getLine(y)?.translateToString(true);

    // Ghostty moves a cleared prompt screen into history within the same write.
    await write('out1\r\nout2\r\n\x1b]133;A\x07$ \x1b]133;B\x07\x1b[H\x1b[2J');
    expect([line(0), line(1), line(2)]).toEqual(['out1', 'out2', '$']);

    await write('\x1b[1;1Htop\x1b[S');
    expect(line(3)).toBe('top');

    const scrolled = new Promise<void>((resolve) => {
      const subscription = terminal.onScroll(() => {
        subscription.dispose();
        resolve();
      });
    });
    terminal.scrollLines(-3);
    await scrolled;
    const active = terminal.buffer.active.baseY + 1;
    await write('\x1b[2;1HUP');
    expect(line(active)).toBe('UP');
  });

  it('positions decorations relative to the current viewport', async () => {
    const terminal = new Terminal({
      cols: 8,
      rows: 2,
      scrollback: 10,
      allowProposedApi: true,
    });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    await new Promise<void>((resolve) => terminal.write('one\r\ntwo\r\nthree', resolve));
    const marker = terminal.registerMarker();
    const decoration = terminal.registerDecoration({ marker, width: 2 });
    const element = decoration?.element;
    expect(element).toBeInstanceOf(HTMLElement);
    expect(element?.style.display).toBe('');

    const top = new Promise<void>((resolve) => {
      const subscription = terminal.onScroll((position) => {
        if (position !== 0) return;
        subscription.dispose();
        resolve();
      });
    });
    terminal.scrollToTop();
    await top;
    await waitFrames(2);
    expect(element?.style.display).toBe('none');

    const bottom = new Promise<void>((resolve) => {
      const subscription = terminal.onScroll((position) => {
        if (position === 0) return;
        subscription.dispose();
        resolve();
      });
    });
    terminal.scrollToBottom();
    await bottom;
    await waitFrames(2);
    expect(element?.style.display).toBe('');
    expect(Number.parseFloat(element?.style.top ?? '')).toBeGreaterThanOrEqual(0);
  });

  it('does not attach rejected or modifier keys to later native input', async () => {
    const terminal = new Terminal();
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const keys = vi.fn();
    terminal.onKey(keys);
    terminal.attachCustomKeyEventHandler(() => false);
    terminal.element?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, code: 'KeyX', key: 'x' })
    );
    terminal.input('programmatic');
    await Promise.resolve();
    await Promise.resolve();
    expect(keys).not.toHaveBeenCalled();
  });

  it('forwards input and explicitly gates unsupported proposed APIs', async () => {
    const terminal = new Terminal();
    compatibleTerminals.push(terminal);
    terminal.open(host());
    const data = new Promise<string>((resolve) => terminal.onData(resolve));
    terminal.input('typed');
    await terminal.ready;
    await expect(data).resolves.toBe('typed');
    expect(() => terminal.unicode.versions).toThrow(XtermCompatibilityError);
  });

  it('runs stable xterm link providers against Ghostty cell geometry', async () => {
    const terminal = new Terminal({ cols: 30, rows: 6 });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const hover = vi.fn();
    const leave = vi.fn();
    const dispose = vi.fn();
    const activated = new Promise<string>((resolve) => {
      terminal.registerLinkProvider({
        provideLinks(line, callback) {
          callback(
            line === 1
              ? [
                  {
                    text: 'link',
                    range: { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } },
                    activate: (_event, text) => resolve(text),
                    hover,
                    leave,
                    dispose,
                  },
                ]
              : undefined
          );
        },
      });
    });
    const element = terminal.element;
    if (!element) throw new Error('Expected an open xterm element');
    const bounds = element.getBoundingClientRect();
    const pointer = { clientX: bounds.left + 2, clientY: bounds.top + 2, bubbles: true };
    element.dispatchEvent(new MouseEvent('mousemove', pointer));
    await Promise.resolve();
    await Promise.resolve();
    expect(hover).toHaveBeenCalledOnce();
    expect(element.querySelector('.xterm-link-decoration')).not.toBeNull();
    element.dispatchEvent(new MouseEvent('mousedown', pointer));
    element.dispatchEvent(new MouseEvent('mouseup', pointer));
    await expect(activated).resolves.toBe('link');
    element.dispatchEvent(new MouseEvent('mouseleave', pointer));
    expect(leave).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('maps complete xterm themes and init-only transparency before open', async () => {
    const terminal = new Terminal({
      theme: {
        foreground: '#eeeeee',
        background: '#111111cc',
        cursorAccent: '#222222',
        selectionBackground: '#44556680',
        red: '#ff0000',
        extendedAnsi: ['#123456'],
      },
    });
    compatibleTerminals.push(terminal);
    terminal.options.allowTransparency = true;
    terminal.open(host());
    await terminal.ready;
    const native = await terminal.native;
    expect(native.theme.cursorAccent).toBe('#222222');
    expect(native.theme.red).toBe('#ff0000');
    expect(native.theme.extendedAnsi).toEqual(['#123456']);
    expect(() => {
      terminal.options.allowTransparency = false;
    }).toThrow(/init-only/u);

    expect(toXtermTheme({ foreground: { r: 1, g: 2, b: 3 } }).foreground).toBe('rgba(1, 2, 3, 1)');
  });

  it('matches xterm option defaults, validation, and unsupported-option failures', () => {
    const terminal = new Terminal();
    compatibleTerminals.push(terminal);
    expect(terminal.options.fontFamily).toBe('monospace');
    expect(terminal.options.fastScrollSensitivity).toBe(5);
    expect(terminal.options.cursorInactiveStyle).toBe('outline');
    expect(terminal.options.wordSeparator).toBe(' ()[]{}\',"`');
    terminal.options.minimumContrastRatio = 99;
    expect(terminal.options.minimumContrastRatio).toBe(21);
    terminal.options.cursorWidth = 2.8;
    expect(terminal.options.cursorWidth).toBe(2);
    expect(() => terminal.resize(10.5, 2)).toThrow(/integers/u);
    expect(() => {
      terminal.options.tabStopWidth = 4;
    }).toThrow(XtermCompatibilityError);
    expect(() => {
      terminal.options.smoothScrollDuration = 100;
    }).toThrow(XtermCompatibilityError);
  });
});

async function waitFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

describe('native themes', () => {
  it('replaces, patches, and mirrors resolved host colors', async () => {
    const terminal = await createTerminal({
      container: host(),
      worker: false,
      renderer: 'canvas2d',
    });
    nativeTerminals.push(terminal);
    await terminal.setTheme({ appearance: 'light', background: '#ffffff', foreground: '#111111' });
    expect(terminal.element.style.colorScheme).toBe('light');
    expect(terminal.element.style.getPropertyValue('--gespenst-terminal-background')).toBe(
      'rgba(255, 255, 255, 1)'
    );
    await terminal.updateTheme({ cursor: '#ff0000' });
    expect(terminal.theme.background).toBe('#ffffff');
    expect(terminal.theme.cursor).toBe('#ff0000');
  });

  it('requires the init-only transparency option for transparent terminal colors', async () => {
    await expect(
      createTerminal({ container: host(), theme: { background: '#00000080' } })
    ).rejects.toThrow(/allowTransparency/u);
    const terminal = await createTerminal({
      container: host(),
      worker: false,
      renderer: 'canvas2d',
      allowTransparency: true,
      theme: { background: '#00000080' },
    });
    nativeTerminals.push(terminal);
    expect(terminal.element.style.backgroundColor).toBe('transparent');
  });
});

describe('shared worker sessions', () => {
  it('isolates terminal state while sharing one worker host', async () => {
    const first = await createTerminal({ container: host(), worker: 'shared', cols: 20, rows: 3 });
    const second = await createTerminal({ container: host(), worker: 'shared', cols: 20, rows: 3 });
    nativeTerminals.push(first, second);
    await Promise.all([first.writeAsync('first only'), second.writeAsync('second only')]);
    const [firstView, secondView] = await Promise.all([
      first.readViewport(),
      second.readViewport(),
    ]);

    expect(firstView.viewportRows[0]?.text).toContain('first only');
    expect(firstView.viewportRows[0]?.text).not.toContain('second only');
    expect(secondView.viewportRows[0]?.text).toContain('second only');

    await first.setTheme({ appearance: 'light', background: '#ffffff', foreground: '#101010' });
    expect(first.theme.background).toBe('#ffffff');
    expect(first.element.style.colorScheme).toBe('light');
    expect(second.theme.background).toBeUndefined();
  });
});

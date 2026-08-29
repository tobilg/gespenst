import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal, toXtermTheme, XtermCompatibilityError } from '../../../xterm/src';
import { createTerminal, type GespenstTerminal, type TerminalBufferSnapshot } from '../../src';

const nativeTerminals: GespenstTerminal[] = [];
const compatibleTerminals: Terminal[] = [];
const compatibilityBridgeKey = Symbol.for('@gespenst/core/xterm-compatibility');

interface CompatibilityBridge {
  writeAsync(data: Uint8Array, owned: boolean): Promise<unknown>;
}

function compatibilityBridge(native: GespenstTerminal): CompatibilityBridge {
  const bridge = (native as unknown as Record<symbol, CompatibilityBridge | undefined>)[
    compatibilityBridgeKey
  ];
  if (!bridge) throw new Error('Core compatibility bridge is unavailable');
  return bridge;
}

function disableCompatibilityBridge(native: GespenstTerminal): void {
  delete (native as unknown as Record<symbol, CompatibilityBridge | undefined>)[
    compatibilityBridgeKey
  ];
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
    const writeAsync = vi.spyOn(compatibilityBridge(native), 'writeAsync');
    const callbacks: number[] = [];

    terminal.write('one', () => callbacks.push(1));
    terminal.write(' two', () => callbacks.push(2));
    await new Promise<void>((resolve) =>
      terminal.write(' three', () => {
        callbacks.push(3);
        resolve();
      })
    );

    expect(writeAsync).toHaveBeenCalledOnce();
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

  it('shifts and disposes markers as retained rows are trimmed', async () => {
    const terminal = new Terminal({
      cols: 8,
      rows: 2,
      scrollback: 1,
      allowProposedApi: true,
    });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const native = await terminal.native;
    disableCompatibilityBridge(native);
    let snapshot = bufferSnapshot(['a', 'b', 'c'], 1);
    vi.spyOn(native, 'readBuffer').mockImplementation(async () => snapshot);
    await new Promise<void>((resolve) => terminal.write('seed', resolve));
    const marker = terminal.registerMarker();
    const disposed = vi.fn();
    marker.onDispose(disposed);

    snapshot = bufferSnapshot(['b', 'c', 'd'], 2);
    await new Promise<void>((resolve) => terminal.write('x', resolve));
    expect(marker.line).toBe(1);
    snapshot = bufferSnapshot(['c', 'd', 'e'], 3);
    await new Promise<void>((resolve) => terminal.write('x', resolve));
    expect(marker.line).toBe(0);
    expect(marker.isDisposed).toBe(false);
    snapshot = bufferSnapshot(['d', 'e', 'f'], 4);
    await new Promise<void>((resolve) => terminal.write('x', resolve));
    expect(marker.line).toBe(-1);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('preserves markers until a non-overlapping viewport is resolved by a full read', async () => {
    const terminal = new Terminal({
      cols: 8,
      rows: 2,
      scrollback: 4,
      allowProposedApi: true,
    });
    compatibleTerminals.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const native = await terminal.native;
    disableCompatibilityBridge(native);
    const initial = bufferSnapshot(['a', 'b', 'c', 'd', 'e', 'f'], 1);
    const partial = bufferSnapshot(['g', 'h'], 2, 4, 6);
    const complete = bufferSnapshot(['c', 'd', 'e', 'f', 'g', 'h'], 2);
    let jumped = false;
    const readBuffer = vi.spyOn(native, 'readBuffer').mockImplementation(async (range) => {
      if (!jumped) return initial;
      return range ? complete : partial;
    });
    await new Promise<void>((resolve) => terminal.write('seed', resolve));
    const marker = terminal.registerMarker();
    const disposed = vi.fn();
    marker.onDispose(disposed);

    jumped = true;
    await new Promise<void>((resolve) => terminal.write('jump', resolve));

    expect(readBuffer).toHaveBeenCalledWith({ start: 0, end: 6 });
    expect(marker.line).toBe(0);
    expect(marker.isDisposed).toBe(false);
    expect(disposed).not.toHaveBeenCalled();
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

function bufferSnapshot(
  ids: readonly string[],
  revision: number,
  start = 0,
  totalRows = ids.length
): TerminalBufferSnapshot {
  return {
    state: {
      screen: 'normal',
      totalRows,
      scrollbackRows: 1,
      viewportY: 1,
      viewportLength: 2,
      cursorX: 0,
      cursorY: 1,
      revision,
    },
    rows: ids.map((id, index) => ({
      index: start + index,
      id,
      text: id,
      cells: [],
      wrapped: false,
      wrapContinuation: false,
      selection: null,
    })),
  };
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

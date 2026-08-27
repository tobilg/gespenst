import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminal, type GespenstTerminal, type TerminalGeometry } from '../../src';
import { createCoreRuntime } from '../../src/core';

const terminals: GespenstTerminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function container(): HTMLDivElement {
  const element = document.createElement('div');
  element.style.width = '320px';
  element.style.height = '180px';
  document.body.append(element);
  return element;
}

describe('browser terminal', () => {
  it('reports retained-buffer invalidations without treating scrolling as content changes', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
      cols: 8,
      rows: 2,
    });
    terminals.push(terminal);
    const reasons: string[] = [];
    terminal.on('bufferChange', ({ reason }) => reasons.push(reason));

    terminal.write('one');
    await terminal.writeAsync('\r\ntwo\r\nthree');
    terminal.resize(9, 3);
    const snapshot = await terminal.snapshot();
    await terminal.restore(snapshot);
    terminal.reset();
    terminal.setScrollbackLines(20);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const beforeScroll = reasons.length;
    terminal.scrollToTop();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(reasons).toEqual(
      expect.arrayContaining(['write', 'resize', 'restore', 'reset', 'scrollback'])
    );
    expect(reasons.filter((reason) => reason === 'write')).toHaveLength(2);
    expect(reasons).toHaveLength(beforeScroll);
  });

  it('renders and accepts input on the main-thread fallback', async () => {
    const host = container();
    const terminal = await createTerminal({
      container: host,
      cols: 32,
      rows: 8,
      worker: false,
      renderer: 'webgl2',
      accessibility: 'full',
    });
    terminals.push(terminal);
    const input: string[] = [];
    terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));
    const transportInput: string[] = [];
    const connection = terminal.connect({
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('\u001b[32mGhostty in the browser\u001b[0m'));
        },
      }),
      writable: new WritableStream({
        write(data) {
          transportInput.push(new TextDecoder().decode(data));
        },
      }),
    });
    terminal.sendKey({ code: 'Enter' });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(terminal.renderer.backend).toBe('webgl2');
    expect(input).toContain('\r');
    expect(transportInput).toContain('\r');
    expect((await terminal.snapshot()).byteLength).toBeGreaterThan(0);
    expect(terminal.element.querySelector('.gespenst__a11y')?.textContent).toContain(
      'Ghostty in the browser'
    );
    expect(terminal.geometry).toMatchObject({ cols: 32, rows: 8 });
    const fixedResizeEvents: TerminalGeometry[] = [];
    terminal.on('resize', (geometry) => fixedResizeEvents.push(geometry));
    host.style.width = '480px';
    terminal.resize();
    expect(fixedResizeEvents).toHaveLength(0);
    expect(terminal.geometry).toMatchObject({ cols: 32, rows: 8 });
    connection.dispose();
  });

  it('falls from WebGL2 to Canvas 2D at runtime without losing terminal state', async () => {
    const terminal = await createTerminal({
      container: container(),
      cols: 80,
      rows: 8,
      worker: false,
      renderer: 'webgl2',
    });
    terminals.push(terminal);
    await terminal.writeAsync('retained across renderer fallback');
    const connection = terminal.connect({
      readable: new ReadableStream(),
      writable: new WritableStream(),
    });
    const rendererEvents: string[] = [];
    terminal.on('renderer', ({ backend }) => rendererEvents.push(backend));
    const activeBackground = [
      ...terminal.element.querySelectorAll<HTMLCanvasElement>('.gespenst__background'),
    ].find((canvas) => canvas.style.display !== 'none');
    if (!activeBackground) throw new Error('Expected an active renderer background');

    activeBackground.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    await terminal.writeAsync(' after loss');

    expect(terminal.renderer.backend).toBe('canvas2d');
    expect(rendererEvents).toContain('canvas2d');
    expect((await terminal.readBuffer()).rows.map((row) => row.text).join('\n')).toContain(
      'retained across renderer fallback'
    );
    expect(connection.status).toBe('open');
    connection.dispose();
  });

  it('exposes geometry and emits changes after container resizing', async () => {
    const host = container();
    const terminal = await createTerminal({
      container: host,
      worker: false,
      renderer: 'webgl2',
    });
    terminals.push(terminal);
    const initial = terminal.geometry;
    expect(Object.isFrozen(initial)).toBe(true);
    expect(initial.widthPx).toBe(initial.cols * initial.cellWidthPx);
    expect(initial.heightPx).toBe(initial.rows * initial.cellHeightPx);
    const probe = document.createElement('canvas').getContext('2d');
    expect(probe).not.toBeNull();
    if (!probe) throw new Error('Canvas 2D is required for this test');
    probe.font = '14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    expect(initial.cellWidthPx).toBe(
      Math.max(1, Math.round(probe.measureText('M').width * devicePixelRatio))
    );

    const events: TerminalGeometry[] = [];
    const resized = new Promise<TerminalGeometry>((resolve) => {
      terminal.on('resize', (geometry) => {
        events.push(geometry);
        resolve(geometry);
      });
    });
    host.style.width = '480px';
    const geometry = await resized;

    expect(geometry).toBe(terminal.geometry);
    expect(geometry.cols).toBeGreaterThan(initial.cols);
    expect(geometry.rows).toBe(initial.rows);
    expect(geometry.widthPx).toBe(geometry.cols * geometry.cellWidthPx);

    terminal.resize();
    expect(events).toHaveLength(1);
  });

  it('runs the WASM core and renderer in a dedicated worker', async () => {
    const host = container();
    const terminal = await createTerminal({
      container: host,
      worker: true,
      renderer: 'webgl2',
    });
    terminals.push(terminal);
    terminal.write('worker terminal');
    const initial = terminal.geometry;
    const snapshot = await terminal.snapshot();
    expect(snapshot.byteLength).toBeGreaterThan(0);

    const resizeEvents: TerminalGeometry[] = [];
    terminal.on('resize', (geometry) => resizeEvents.push(geometry));
    host.style.width = '480px';
    terminal.resize();
    const resized = terminal.geometry;
    expect(resized.cols).toBeGreaterThan(initial.cols);
    expect(resizeEvents).toEqual([resized]);

    await terminal.restore(snapshot);
    expect(terminal.geometry).toBe(resized);
    expect(resizeEvents).toEqual([resized]);

    const reconciled = await terminal.snapshot();
    const runtime = await createCoreRuntime();
    const verifier = runtime.createTerminal();
    verifier.restore(reconciled);
    expect(verifier.geometry).toEqual(resized);
    verifier.dispose();
    runtime.dispose();
  });

  it('accepts URL objects for WASM sources in a dedicated worker', async () => {
    const host = container();
    const terminal = await createTerminal({
      container: host,
      worker: 'dedicated',
      renderer: 'webgl2',
      wasm: new URL('../../src/assets/ghostty-vt.wasm', import.meta.url),
      callbacksWasm: new URL('../../src/assets/ghostty-callbacks.wasm', import.meta.url),
    });
    terminals.push(terminal);

    await terminal.writeAsync('clone-safe URL sources');

    expect((await terminal.snapshot()).byteLength).toBeGreaterThan(0);
  });

  it('settles writeAsync after painting and reports absolute viewport positions', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
      cols: 8,
      rows: 2,
    });
    terminals.push(terminal);
    await terminal.writeAsync('one\r\ntwo\r\nthree');
    expect((await terminal.readBuffer({ start: 0, end: 10 })).rows.map((row) => row.text)).toEqual([
      'one',
      'two',
      'three',
    ]);

    const top = new Promise<number>((resolve) => terminal.on('scroll', resolve));
    terminal.scrollToTop();
    await expect(top).resolves.toBe(0);
    const bottom = new Promise<number>((resolve) => terminal.on('scroll', resolve));
    terminal.scrollToBottom();
    await expect(bottom).resolves.toBe(1);
  });

  it('gives the WebGL2 surface a straight-alpha canvas when transparency is on', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'webgl2',
      allowTransparency: true,
      theme: { background: 'rgba(255, 255, 255, 0.06)', foreground: '#000000' },
    });
    terminals.push(terminal);
    await terminal.writeAsync('transparent');

    expect(terminal.renderer.backend).toBe('webgl2');
    const canvas = terminal.element.querySelector<HTMLCanvasElement>('.gespenst__background');
    if (!canvas) throw new Error('Expected a background canvas');
    const attributes = (
      canvas.getContext('webgl2') as WebGL2RenderingContext | null
    )?.getContextAttributes();
    expect(attributes?.alpha).toBe(true);
    // The renderer clears and blends with straight alpha. Compositing the canvas as premultiplied
    // renders a translucent background fully opaque.
    expect(attributes?.premultipliedAlpha).toBe(false);
  });

  it('types characters a layout composes with AltGr or Option', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    const input: string[] = [];
    terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));
    const textarea = terminal.element.querySelector('textarea');
    if (!textarea) throw new Error('Expected terminal textarea');
    const press = (init: KeyboardEventInit) => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
    };

    // German Mac composes these with Option; German Windows and Linux use AltGr, which the
    // browser reports as Ctrl+Alt plus the AltGraph modifier state.
    press({ key: '|', code: 'Digit7', altKey: true });
    press({ key: '@', code: 'KeyL', altKey: true });
    press({ key: '|', code: 'IntlBackslash', ctrlKey: true, altKey: true, modifierAltGraph: true });
    await terminal.writeAsync('');

    expect(input.join('')).toBe('|@|');
  });

  it('still sends Alt with a key that types its own character', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    const input: string[] = [];
    terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));
    const textarea = terminal.element.querySelector('textarea');
    if (!textarea) throw new Error('Expected terminal textarea');

    // Alt+B is meta, not a composed character, so it must not type a bare "b".
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', altKey: true, bubbles: true })
    );
    await terminal.writeAsync('');

    expect(input.join('')).not.toBe('b');
    expect(input.join('')).toContain('\u001b');
  });

  it('commits IME composition exactly once', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    const input: string[] = [];
    terminal.on('input', ({ data, source }) => {
      if (source === 'text') input.push(new TextDecoder().decode(data));
    });
    const textarea = terminal.element.querySelector('textarea');
    if (!textarea) throw new Error('Expected terminal textarea');
    await terminal.writeAsync('\x1b[3;5H');
    const cellWidthCss = terminal.geometry.cellWidthPx / devicePixelRatio;
    const cellHeightCss = terminal.geometry.cellHeightPx / devicePixelRatio;
    expect(textarea.getBoundingClientRect().left).toBeCloseTo(
      terminal.element.getBoundingClientRect().left + 4 * cellWidthCss,
      4
    );
    expect(textarea.getBoundingClientRect().top).toBeCloseTo(
      terminal.element.getBoundingClientRect().top + 2 * cellHeightCss,
      4
    );
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.value = 'に';
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'に' }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本' }));
    textarea.value = '日本';
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '日本' }));
    expect(input).toEqual(['日本']);
  });

  it('encodes Return from an iOS-style code-less keydown', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    const input: string[] = [];
    terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));
    const textarea = terminal.element.querySelector('textarea');
    if (!textarea) throw new Error('Expected terminal textarea');

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: '', bubbles: true, cancelable: true })
    );

    expect(input).toEqual(['\r']);
  });

  it('normalizes a virtual-keyboard textarea line break to terminal Enter', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    const input: string[] = [];
    terminal.on('input', ({ data, source }) => {
      if (source === 'text') input.push(new TextDecoder().decode(data));
    });
    const textarea = terminal.element.querySelector('textarea');
    if (!textarea) throw new Error('Expected terminal textarea');

    textarea.value = '\n';
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        data: null,
        inputType: 'insertLineBreak',
      })
    );

    expect(input).toEqual(['\r']);
    expect(textarea.value).toBe('');
  });

  it('accepts equal cloned byte sources in a shared worker', async () => {
    const [wasm, callbacks] = await Promise.all([
      fetch(new URL('../../src/assets/ghostty-vt.wasm', import.meta.url)).then((value) =>
        value.arrayBuffer()
      ),
      fetch(new URL('../../src/assets/ghostty-callbacks.wasm', import.meta.url)).then((value) =>
        value.arrayBuffer()
      ),
    ]);
    const [first, second] = await Promise.all([
      createTerminal({
        container: container(),
        worker: 'shared',
        wasm: wasm.slice(0),
        callbacksWasm: callbacks.slice(0),
      }),
      createTerminal({
        container: container(),
        worker: 'shared',
        wasm: wasm.slice(0),
        callbacksWasm: callbacks.slice(0),
      }),
    ]);
    terminals.push(first, second);
    await Promise.all([first.writeAsync('first'), second.writeAsync('second')]);
    expect((await second.readViewport()).viewportRows[0]?.text).toContain('second');
  });

  it('rejects a failed connection even when the readable side remains open', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    const connection = terminal.connect({
      readable: new ReadableStream(),
      writable: new WritableStream({
        write() {
          throw new Error('write failed');
        },
      }),
    });
    terminal.sendText('x');
    await expect(connection.closed).rejects.toThrow('write failed');
    expect(connection.status).toBe('error');
  });

  it('closes the writable transport after readable EOF', async () => {
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    const close = vi.fn();
    const connection = terminal.connect({
      readable: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      writable: new WritableStream({ close }),
    });

    await expect(connection.closed).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(connection.status).toBe('closed');
  });

  it('rejects pending requests when the worker fails', async () => {
    class FailingWorker {
      static instance: FailingWorker | null = null;
      private readonly listeners = new Map<string, Set<(event: never) => void>>();

      constructor() {
        FailingWorker.instance = this;
      }

      addEventListener(type: string, listener: (event: never) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: never) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      postMessage(message: { terminalId: number; type: string }): void {
        if (message.type !== 'init') return;
        queueMicrotask(() => {
          this.dispatch('message', {
            data: {
              terminalId: message.terminalId,
              type: 'ready',
              renderer: { backend: 'canvas2d', textShaping: 'browser-canvas' },
              surfaceIndex: 0,
            },
          });
        });
      }

      terminate(): void {}

      fail(): void {
        this.dispatch('error', { error: new Error('worker crashed'), message: 'worker crashed' });
      }

      private dispatch(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event as never);
      }
    }
    vi.stubGlobal('Worker', FailingWorker);
    const terminal = await createTerminal({ container: container(), worker: true });
    terminals.push(terminal);
    const snapshot = terminal.snapshot();
    FailingWorker.instance?.fail();

    await expect(snapshot).rejects.toThrow('worker crashed');
    await expect(terminal.readViewport()).rejects.toThrow('worker crashed');
  });

  it('recreates transferred canvases and starts locally when a dedicated worker cannot start', async () => {
    class StartupFailingWorker {
      static readonly terminate = vi.fn();
      private readonly listeners = new Map<string, Set<(event: never) => void>>();

      addEventListener(type: string, listener: (event: never) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: never) => void): void {
        this.listeners.get(type)?.delete(listener);
      }

      postMessage(message: { type: string }): void {
        if (message.type !== 'init') return;
        queueMicrotask(() =>
          this.dispatch('error', {
            error: new Error('worker initialization failed'),
            message: 'worker initialization failed',
          })
        );
      }

      terminate(): void {
        StartupFailingWorker.terminate();
      }

      private dispatch(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event as never);
      }
    }
    vi.stubGlobal('Worker', StartupFailingWorker);

    const terminal = await createTerminal({
      container: container(),
      worker: 'dedicated',
      renderer: 'canvas2d',
    });
    terminals.push(terminal);
    await terminal.writeAsync('local retry works');

    expect(StartupFailingWorker.terminate).toHaveBeenCalledOnce();
    expect(terminal.renderer.backend).toBe('canvas2d');
    expect((await terminal.readViewport()).viewportRows[0]?.text).toContain('local retry works');
    expect(terminal.element.querySelectorAll('.gespenst__canvas')).toHaveLength(2);
  });

  it('normalizes pixel, line, and page wheel deltas with fractional accumulation', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const terminal = await createTerminal({
      container: container(),
      worker: false,
      renderer: 'canvas2d',
      cols: 8,
      rows: 2,
    });
    terminals.push(terminal);
    await terminal.writeAsync('0\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7');
    const top = new Promise<void>((resolve) => {
      const subscription = terminal.on('scroll', (position) => {
        if (position !== 0) return;
        subscription.dispose();
        resolve();
      });
    });
    terminal.scrollToTop();
    await top;
    const cellHeightCss = terminal.geometry.cellHeightPx / 2;
    terminal.element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: cellHeightCss * 0.4, deltaMode: 0, bubbles: true })
    );
    terminal.element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: cellHeightCss * 0.4, deltaMode: 0, bubbles: true })
    );
    expect((await terminal.readBuffer()).state.viewportY).toBe(0);

    const pixelScroll = waitForViewport(terminal, 1);
    terminal.element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: cellHeightCss * 0.4, deltaMode: 0, bubbles: true })
    );
    await pixelScroll;

    const lineScroll = waitForViewport(terminal, 3);
    terminal.element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 2, deltaMode: 1, bubbles: true })
    );
    await lineScroll;

    const pageScroll = waitForViewport(terminal, 5);
    terminal.element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 1, deltaMode: 2, bubbles: true })
    );
    await pageScroll;
  });
});

function waitForViewport(terminal: GespenstTerminal, position: number): Promise<void> {
  return new Promise((resolve) => {
    const subscription = terminal.on('viewportChange', ({ state }) => {
      if (state.viewportY !== position) return;
      subscription.dispose();
      resolve();
    });
  });
}

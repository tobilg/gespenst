import { describe, expect, it, vi } from 'vitest';
import type {
  CoreRuntime,
  CoreTerminal,
  RenderFrame,
  TerminalBufferSnapshot,
  TerminalBufferState,
  ViewportSnapshot,
} from '../src/core/index.js';
import {
  type MainToWorkerMessage,
  TERMINAL_PROTOCOL_VERSION,
  type WorkerToMainMessage,
} from '../src/protocol.js';
import type { HybridRenderer, RenderMetrics } from '../src/renderers/hybrid.js';
import {
  TerminalWorkerHost,
  type TerminalWorkerHostDependencies,
  type TerminalWorkerScope,
} from '../src/worker/terminal-worker-host.js';

const metrics: RenderMetrics = {
  width: 80,
  height: 40,
  cellWidth: 8,
  cellHeight: 20,
  fontSize: 14,
  fontFamily: 'monospace',
  fontWeight: 400,
  fontWeightBold: 700,
  letterSpacing: 0,
  devicePixelRatio: 1,
};

const state: TerminalBufferState = {
  screen: 'normal',
  totalRows: 2,
  scrollbackRows: 0,
  viewportY: 0,
  viewportLength: 2,
  cursorX: 0,
  cursorY: 0,
  revision: 1,
};

const frame = {
  cols: 10,
  rows: 2,
  dirty: 'full',
  changedRows: [],
  cursor: {
    x: 0,
    y: 0,
    visible: true,
    blinking: false,
    passwordInput: false,
    wideTail: false,
    style: 'block',
  },
  colors: {
    foreground: { r: 255, g: 255, b: 255 },
    background: { r: 0, g: 0, b: 0 },
    cursor: null,
    palette: [],
  },
} satisfies RenderFrame;

const viewport = { ...frame, viewportRows: [] } satisfies ViewportSnapshot;
const buffer = { state, rows: [] } satisfies TerminalBufferSnapshot;

describe('TerminalWorkerHost', () => {
  it('serializes shared runtime creation and releases it after the final session', async () => {
    let resolveRuntime!: (runtime: CoreRuntime) => void;
    const runtimePromise = new Promise<CoreRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const terminals = [fakeTerminal(), fakeTerminal()];
    const runtime = fakeRuntime(terminals.map(({ terminal }) => terminal));
    const createRuntime = vi.fn(() => runtimePromise);
    const { host } = workerHost({ createRuntime });

    const first = host.handle(init(1, 7));
    const second = host.handle(init(2, 7));
    expect(createRuntime).toHaveBeenCalledOnce();
    resolveRuntime(runtime.value);
    await Promise.all([first, second]);

    await host.handle({ terminalId: 1, type: 'dispose' });
    expect(runtime.dispose).not.toHaveBeenCalled();
    await host.handle({ terminalId: 2, type: 'dispose' });
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('rejects duplicate and conflicting sessions and cleans up failed initialization', async () => {
    const first = fakeTerminal();
    const second = fakeTerminal();
    const runtime = fakeRuntime([first.terminal, second.terminal]);
    const createRenderer = vi
      .fn()
      .mockResolvedValueOnce(fakeRenderer().renderer)
      .mockRejectedValueOnce(new Error('renderer failed'));
    const { host } = workerHost({
      createRuntime: vi.fn(async () => runtime.value),
      createRenderer,
    });

    await host.handle(init(1, 5));
    await expect(host.handle(init(1, 5))).rejects.toThrow('already exists');
    await expect(host.handle(init(2, 6))).rejects.toThrow('same WASM sources');
    await expect(host.handle(init(2, 5))).rejects.toThrow('renderer failed');
    expect(second.dispose).toHaveBeenCalledOnce();

    await host.handle({ terminalId: 1, type: 'dispose' });
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('handles the complete request protocol and forwards terminal events', async () => {
    const value = fakeTerminal();
    const runtime = fakeRuntime([value.terminal]);
    const renderer = fakeRenderer();
    const font = {} as FontFace;
    const loadFontFace = vi.fn(async () => font);
    const { host, messages, fonts } = workerHost({
      createRuntime: vi.fn(async () => runtime.value),
      createRenderer: vi.fn(async () => renderer.renderer),
      loadFontFace,
    });
    await host.handle(init(3, 9, true));

    await host.handle({
      terminalId: 3,
      type: 'write',
      data: new Uint8Array([1, 2]).buffer,
      requestId: 1,
    });
    await host.handle({ terminalId: 3, type: 'resize', cols: 20, rows: 4, metrics });
    await host.handle({
      terminalId: 3,
      type: 'key',
      input: { code: 'KeyA', text: 'a', modifiers: 0, action: 'press' },
    });
    await host.handle({
      terminalId: 3,
      type: 'pointer',
      input: { action: 'press', button: 'left', x: 0, y: 0, modifiers: 0 },
    });
    await host.handle({
      terminalId: 3,
      type: 'wheel',
      input: { action: 'motion', x: 0, y: 0, modifiers: 0 },
      lines: 2,
    });
    await host.handle({ terminalId: 3, type: 'text', data: 'text' });
    await host.handle({ terminalId: 3, type: 'paste', data: 'paste' });
    await host.handle({
      terminalId: 3,
      type: 'clipboardEnable',
      requestId: 10,
      options: { maxBytes: 1024 },
    });
    await host.handle({
      terminalId: 3,
      type: 'clipboardPaste',
      requestId: 11,
      request: {
        contents: [{ mime: 'text/plain', data: new Uint8Array([1, 2]).buffer }],
      },
    });
    await host.handle({ terminalId: 3, type: 'clipboardDisable' });
    await host.handle({
      terminalId: 3,
      type: 'clipboardEnable',
      requestId: 12,
      options: {},
    });
    await host.handle({ terminalId: 3, type: 'focus', focused: true });
    await host.handle({ terminalId: 3, type: 'scroll', delta: 'top' });
    await host.handle({ terminalId: 3, type: 'scroll', delta: 'bottom' });
    await host.handle({ terminalId: 3, type: 'scroll', delta: 2 });
    await host.handle({ terminalId: 3, type: 'selectAll' });
    await host.handle({ terminalId: 3, type: 'clearSelection' });
    await host.handle({ terminalId: 3, type: 'getSelection', requestId: 2 });
    await host.handle({ terminalId: 3, type: 'snapshot', requestId: 3 });
    await host.handle({ terminalId: 3, type: 'viewport', requestId: 4 });
    await host.handle({ terminalId: 3, type: 'buffer', requestId: 5, range: { start: 0, end: 1 } });
    await host.handle({
      terminalId: 3,
      type: 'loadFont',
      requestId: 6,
      face: { family: 'Test', source: 'url(test.woff2)', descriptors: { weight: '400' } },
    });
    await host.handle({ terminalId: 3, type: 'reset' });
    await host.handle({ terminalId: 3, type: 'restore', requestId: 7, data: new ArrayBuffer(1) });
    value.restore.mockImplementationOnce(() => {
      throw new Error('restore failed');
    });
    await host.handle({ terminalId: 3, type: 'restore', requestId: 8, data: new ArrayBuffer(1) });
    await host.handle({
      terminalId: 3,
      type: 'theme',
      requestId: 9,
      theme: { foreground: '#fff' },
    });

    value.events.get('input')?.({ data: new Uint8Array([9]), source: 'text' });
    value.events.get('title')?.('title');
    value.events.get('error')?.(new Error('terminal failed'));

    expect(value.write).toHaveBeenCalled();
    expect(value.resize).toHaveBeenCalledWith(20, 4, 8, 20);
    expect(renderer.resize).toHaveBeenCalledWith(metrics);
    expect(renderer.setFocused).toHaveBeenCalledWith(true);
    expect(loadFontFace).toHaveBeenCalledWith('Test', 'url(test.woff2)', { weight: '400' });
    expect(fonts.add).toHaveBeenCalledWith(font);
    expect(messages.map((message) => message.type)).toEqual(
      expect.arrayContaining([
        'ready',
        'rendered',
        'a11y',
        'written',
        'selection',
        'snapshot',
        'viewport',
        'buffer',
        'fontLoaded',
        'restored',
        'themed',
        'clipboardEnabled',
        'clipboardPasted',
        'input',
        'event',
        'error',
      ])
    );

    await host.handle({ terminalId: 3, type: 'dispose' });
    expect(value.clipboardDispose).toHaveBeenCalledTimes(2);
    expect(fonts.delete).toHaveBeenCalledWith(font);
    expect(renderer.dispose).toHaveBeenCalledOnce();
    await expect(host.handle({ terminalId: 3, type: 'reset' })).rejects.toThrow('not initialized');
  });

  it('reports dispatch and render failures without leaving requests pending', async () => {
    const value = fakeTerminal();
    value.render.mockImplementation(() => {
      throw new Error('paint failed');
    });
    const runtime = fakeRuntime([value.terminal]);
    const { host, messages } = workerHost({ createRuntime: vi.fn(async () => runtime.value) });

    host.dispatch({ terminalId: 99, type: 'reset' });
    await host.handle(init(1, 1));
    await Promise.resolve();
    await Promise.resolve();

    expect(messages.filter((message) => message.type === 'error')).toHaveLength(2);
  });
});

function init(terminalId: number, runtimeKey: number, accessibility = false): MainToWorkerMessage {
  return {
    terminalId,
    type: 'init',
    version: TERMINAL_PROTOCOL_VERSION,
    options: {
      runtimeKey,
      cols: 10,
      rows: 2,
      cellWidthPx: 8,
      cellHeightPx: 20,
      scrollbackLines: 10,
      metrics,
      renderer: 'canvas2d',
      accessibility,
      allowTransparency: false,
      minimumContrastRatio: 1,
      backgroundCanvas: {} as OffscreenCanvas,
      textCanvas: {} as OffscreenCanvas,
    },
  };
}

function workerHost(overrides: Partial<TerminalWorkerHostDependencies> = {}) {
  const messages: WorkerToMainMessage[] = [];
  const fonts = { add: vi.fn(), delete: vi.fn() };
  const scope: TerminalWorkerScope = {
    postMessage(message) {
      messages.push(message);
    },
    requestAnimationFrame(callback) {
      callback(0);
      return 1;
    },
    fonts,
  };
  const dependencies: TerminalWorkerHostDependencies = {
    createRuntime: vi.fn(async () => fakeRuntime([fakeTerminal().terminal]).value),
    createRenderer: vi.fn(async () => fakeRenderer().renderer),
    loadFontFace: vi.fn(async () => ({}) as FontFace),
    ...overrides,
  };
  return { host: new TerminalWorkerHost(scope, dependencies), messages, fonts };
}

function fakeRuntime(terminals: CoreTerminal[]) {
  const dispose = vi.fn();
  const createTerminal = vi.fn(() => {
    const terminal = terminals.shift();
    if (!terminal) throw new Error('No fake terminal available');
    return terminal;
  });
  return {
    dispose,
    createTerminal,
    value: { createTerminal, dispose } as unknown as CoreRuntime,
  };
}

function fakeRenderer() {
  const resize = vi.fn();
  const render = vi.fn();
  const setFocused = vi.fn();
  const dispose = vi.fn();
  return {
    resize,
    render,
    setFocused,
    dispose,
    renderer: {
      info: { backend: 'canvas2d', textShaping: 'browser-canvas' },
      resize,
      render,
      setFocused,
      dispose,
    } as unknown as HybridRenderer,
  };
}

function fakeTerminal() {
  const events = new Map<string, (value: unknown) => void>();
  const clipboardDispose = vi.fn();
  const methods = {
    write: vi.fn(),
    resize: vi.fn(),
    key: vi.fn(),
    pointer: vi.fn(),
    wheel: vi.fn(),
    text: vi.fn(),
    paste: vi.fn(),
    enableClipboard: vi.fn(() => ({ dispose: clipboardDispose })),
    pasteClipboard: vi.fn(() => ({ status: 'written', kind: 'kitty' })),
    focus: vi.fn(),
    scrollToTop: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollLines: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    getSelection: vi.fn(() => 'selection'),
    snapshot: vi.fn(() => new Uint8Array([1, 2, 3])),
    viewport: vi.fn(() => viewport),
    readBuffer: vi.fn(() => buffer),
    reset: vi.fn(),
    restore: vi.fn(),
    setTheme: vi.fn(async () => undefined),
    render: vi.fn(() => frame),
    bufferState: vi.fn(() => state),
    dispose: vi.fn(),
    on: vi.fn((name: string, listener: (value: unknown) => void) => {
      events.set(name, listener);
      return { dispose() {} };
    }),
  };
  return { ...methods, clipboardDispose, events, terminal: methods as unknown as CoreTerminal };
}

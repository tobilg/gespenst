import './style.css';

import { TypedEventEmitter } from './core/events.js';
import {
  type CoreRuntime,
  type CoreTerminal,
  createCoreRuntime,
  KeyModifiers,
} from './core/index.js';
import {
  cloneTerminalTheme,
  mergeTerminalTheme,
  resolveTerminalTheme,
  ThemeValidationError,
  terminalColorToCss,
} from './core/theme.js';
import type {
  ClipboardPasteRequest,
  ClipboardPasteResult,
  ClipboardProtocolOptions,
  Disposable,
  InputSource,
  KeyInput,
  MouseButton,
  PointerInput,
  TerminalBufferRange,
  TerminalBufferSnapshot,
  TerminalBufferState,
  TerminalGeometry,
  TerminalTheme,
  ViewportSnapshot,
} from './core/types.js';
import {
  type MainToWorkerPayload,
  TERMINAL_PROTOCOL_VERSION,
  type WorkerEventName,
  type WorkerInitOptions,
  type WorkerToMainMessage,
} from './protocol.js';
import { HybridRenderer, type RendererInfo, type RenderMetrics } from './renderers/hybrid.js';
import type {
  BrowserTerminal,
  BrowserTerminalEventMap,
  TerminalAddon,
  TerminalConnection,
  TerminalConnectionOptions,
  TerminalConnectionStatus,
  TerminalFontFace,
  TerminalFontOptions,
  TerminalOptions,
  TerminalTransport,
} from './types.js';

interface BackendEvents {
  input(data: Uint8Array, source: InputSource): void;
  event(name: WorkerEventName, value: unknown): void;
  a11y(rows: readonly string[]): void;
  rendered(state: TerminalBufferState): void;
  error(error: Error): void;
}

interface Backend {
  readonly renderer: RendererInfo;
  write(data: Uint8Array): void;
  writeAsync(data: Uint8Array): Promise<void>;
  resize(cols: number, rows: number, metrics: RenderMetrics): void;
  key(input: KeyInput): void;
  pointer(input: PointerInput): void;
  wheel(input: PointerInput, lines: number): void;
  text(data: string): void;
  paste(data: string): void;
  enableClipboard(options: ClipboardProtocolOptions): Promise<void>;
  disableClipboard(): void;
  pasteClipboard(request: ClipboardPasteRequest): Promise<ClipboardPasteResult>;
  focus(focused: boolean): void;
  scroll(delta: number | 'top' | 'bottom'): void;
  selectAll(): void;
  clearSelection(): void;
  getSelection(): Promise<string>;
  snapshot(): Promise<Uint8Array>;
  viewport(): Promise<ViewportSnapshot>;
  buffer(range?: TerminalBufferRange): Promise<TerminalBufferSnapshot>;
  loadFont(face: TerminalFontFace): Promise<void>;
  restore(data: Uint8Array): Promise<void>;
  reset(): void;
  setTheme(theme: TerminalTheme): Promise<void>;
  setScrollbackLines(lines: number): void;
  setDefaultCursor(style: import('./core/types.js').CursorStyle, blink: boolean): void;
  setAccessibility(enabled: boolean): void;
  setMinimumContrastRatio(ratio: number): void;
  dispose(): void;
}

interface TerminalDom {
  readonly root: HTMLDivElement;
  readonly background: HTMLCanvasElement;
  readonly text: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly a11y: HTMLDivElement;
}

interface Layout {
  readonly cols: number;
  readonly rows: number;
  readonly metrics: RenderMetrics;
}

let nextWorkerTerminalId = 1;
interface SharedWorkerHost {
  readonly worker: Worker;
  references: number;
  readonly runtimeKey: number;
  readonly wasm: unknown;
  readonly callbacksWasm: unknown;
}

let sharedWorkerHost: SharedWorkerHost | null = null;
let nextRuntimeKey = 1;

function createTerminalWorker(): Worker {
  return new Worker(new URL('./worker/terminal-worker.ts', import.meta.url), {
    type: 'module',
    name: 'gespenst',
  });
}

function acquireWorker(
  shared: boolean,
  wasm: unknown,
  callbacksWasm: unknown
): {
  worker: Worker;
  terminalId: number;
  runtimeKey: number;
  release(): void;
} {
  const terminalId = nextWorkerTerminalId++;
  if (!shared) {
    const worker = createTerminalWorker();
    return {
      worker,
      terminalId,
      runtimeKey: nextRuntimeKey++,
      release: () => worker.terminate(),
    };
  }
  if (!sharedWorkerHost) {
    sharedWorkerHost = {
      worker: createTerminalWorker(),
      references: 0,
      runtimeKey: nextRuntimeKey++,
      wasm: canonicalWasmSource(wasm),
      callbacksWasm: canonicalWasmSource(callbacksWasm),
    };
  } else if (
    !sameWasmSource(sharedWorkerHost.wasm, wasm) ||
    !sameWasmSource(sharedWorkerHost.callbacksWasm, callbacksWasm)
  ) {
    throw new Error('Shared worker terminals must use the same WASM sources');
  }
  const host = sharedWorkerHost;
  host.references += 1;
  return {
    worker: host.worker,
    terminalId,
    runtimeKey: host.runtimeKey,
    release() {
      host.references -= 1;
      if (host.references === 0) {
        host.worker.terminate();
        if (sharedWorkerHost === host) sharedWorkerHost = null;
      }
    },
  };
}

function canonicalWasmSource(source: unknown): unknown {
  if (source instanceof URL) return source.href;
  if (source instanceof Uint8Array) return source.slice();
  if (source instanceof ArrayBuffer) return source.slice(0);
  return source;
}

function sameWasmSource(left: unknown, rightValue: unknown): boolean {
  const right = rightValue instanceof URL ? rightValue.href : rightValue;
  if (left === right) return true;
  const leftBytes =
    left instanceof ArrayBuffer ? new Uint8Array(left) : left instanceof Uint8Array ? left : null;
  const rightBytes =
    right instanceof ArrayBuffer
      ? new Uint8Array(right)
      : right instanceof Uint8Array
        ? right
        : null;
  if (!leftBytes || !rightBytes || leftBytes.byteLength !== rightBytes.byteLength) return false;
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

function cloneSafeWasmSource(
  source: TerminalOptions['wasm']
): WorkerInitOptions['wasm'] | undefined {
  return source instanceof URL ? source.href : source;
}

class WorkerBackend implements Backend {
  readonly renderer: RendererInfo;
  private nextRequest = 1;
  private failure: Error | null = null;
  private disposed = false;
  private readonly pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
  >();
  private readonly worker: Worker;
  private readonly terminalId: number;
  private readonly releaseWorker: () => void;
  private readonly onMessage: (event: MessageEvent<WorkerToMainMessage>) => void;
  private readonly onError: (event: ErrorEvent) => void;

  private constructor(
    worker: Worker,
    terminalId: number,
    renderer: RendererInfo,
    releaseWorker: () => void,
    events: BackendEvents
  ) {
    this.worker = worker;
    this.terminalId = terminalId;
    this.renderer = renderer;
    this.releaseWorker = releaseWorker;
    this.onMessage = (event) => {
      if (event.data.terminalId === terminalId) this.receive(event.data, events);
    };
    this.onError = (event) => {
      const cause = event.error;
      this.fail(
        cause instanceof Error && cause.message
          ? cause
          : new Error(event.message || 'Terminal worker failed'),
        events
      );
    };
  }

  static async create(
    dom: TerminalDom,
    layout: Layout,
    options: TerminalOptions,
    events: BackendEvents
  ): Promise<WorkerBackend> {
    const wasm = cloneSafeWasmSource(options.wasm);
    const callbacksWasm = cloneSafeWasmSource(options.callbacksWasm);
    const { worker, terminalId, runtimeKey, release } = acquireWorker(
      options.worker === 'shared',
      wasm,
      callbacksWasm
    );
    const backgroundCanvas = dom.background.transferControlToOffscreen();
    const textCanvas = dom.text.transferControlToOffscreen();
    const ready = new Promise<RendererInfo>((resolve, reject) => {
      const cleanup = () => {
        worker.removeEventListener('message', startup);
        worker.removeEventListener('error', workerError);
      };
      const startup = (event: MessageEvent<WorkerToMainMessage>) => {
        if (event.data.terminalId !== terminalId) return;
        if (event.data.type === 'ready') {
          cleanup();
          resolve(event.data.renderer);
        } else if (event.data.type === 'error') {
          cleanup();
          reject(new Error(event.data.message));
        }
      };
      const workerError = (event: ErrorEvent) => {
        cleanup();
        const cause = event.error;
        if (cause instanceof Error && cause.message) reject(cause);
        else reject(new Error(event.message || 'Terminal worker failed to load'));
      };
      worker.addEventListener('message', startup);
      worker.addEventListener('error', workerError);
    });
    const message: MainToWorkerPayload = {
      type: 'init',
      version: TERMINAL_PROTOCOL_VERSION,
      options: {
        runtimeKey,
        backgroundCanvas,
        textCanvas,
        metrics: layout.metrics,
        renderer: options.renderer ?? 'auto',
        accessibility: options.accessibility === 'full',
        allowTransparency: options.allowTransparency ?? false,
        minimumContrastRatio: options.minimumContrastRatio ?? 1,
        cols: layout.cols,
        rows: layout.rows,
        cellWidthPx: layout.metrics.cellWidth,
        cellHeightPx: layout.metrics.cellHeight,
        ...(options.scrollbackLines === undefined
          ? {}
          : { scrollbackLines: options.scrollbackLines }),
        ...(options.theme ? { theme: options.theme } : {}),
        ...(options.defaultCursorStyle ? { defaultCursorStyle: options.defaultCursorStyle } : {}),
        ...(options.defaultCursorBlink === undefined
          ? {}
          : { defaultCursorBlink: options.defaultCursorBlink }),
        ...(wasm === undefined ? {} : { wasm }),
        ...(callbacksWasm === undefined ? {} : { callbacksWasm }),
      },
    };
    worker.postMessage({ ...message, terminalId }, [backgroundCanvas, textCanvas]);
    let renderer: RendererInfo;
    try {
      renderer = await ready;
    } catch (error) {
      release();
      throw error;
    }
    const backend = new WorkerBackend(worker, terminalId, renderer, release, events);
    worker.addEventListener('message', backend.onMessage);
    worker.addEventListener('error', backend.onError);
    return backend;
  }

  write(data: Uint8Array): void {
    const value = data.slice().buffer;
    this.post({ type: 'write', data: value }, [value]);
  }

  writeAsync(data: Uint8Array): Promise<void> {
    const value = data.slice().buffer;
    return this.request<void>((requestId) => ({ type: 'write', data: value, requestId }), [value]);
  }

  resize(cols: number, rows: number, metrics: RenderMetrics): void {
    this.post({ type: 'resize', cols, rows, metrics });
  }

  key(input: KeyInput): void {
    this.post({ type: 'key', input });
  }

  pointer(input: PointerInput): void {
    this.post({ type: 'pointer', input });
  }

  wheel(input: PointerInput, lines: number): void {
    this.post({ type: 'wheel', input, lines });
  }

  text(data: string): void {
    this.post({ type: 'text', data });
  }

  paste(data: string): void {
    this.post({ type: 'paste', data });
  }

  enableClipboard(options: ClipboardProtocolOptions): Promise<void> {
    return this.request<void>((requestId) => ({
      type: 'clipboardEnable',
      requestId,
      options,
    }));
  }

  disableClipboard(): void {
    this.post({ type: 'clipboardDisable' });
  }

  pasteClipboard(request: ClipboardPasteRequest): Promise<ClipboardPasteResult> {
    const contents = request.contents.map(({ mime, data }) => ({
      mime,
      data: data.slice().buffer,
    }));
    return this.request<ClipboardPasteResult>(
      (requestId) => ({
        type: 'clipboardPaste',
        requestId,
        request: {
          contents,
          ...(request.location === undefined ? {} : { location: request.location }),
          ...(request.allowUnsafe === undefined ? {} : { allowUnsafe: request.allowUnsafe }),
        },
      }),
      contents.map(({ data }) => data)
    );
  }

  focus(focused: boolean): void {
    this.post({ type: 'focus', focused });
  }

  scroll(delta: number | 'top' | 'bottom'): void {
    this.post({ type: 'scroll', delta });
  }

  selectAll(): void {
    this.post({ type: 'selectAll' });
  }

  clearSelection(): void {
    this.post({ type: 'clearSelection' });
  }

  getSelection(): Promise<string> {
    return this.request<string>((requestId) => ({ type: 'getSelection', requestId }));
  }

  snapshot(): Promise<Uint8Array> {
    return this.request<ArrayBuffer>((requestId) => ({ type: 'snapshot', requestId })).then(
      (data) => new Uint8Array(data)
    );
  }

  viewport(): Promise<ViewportSnapshot> {
    return this.request<ViewportSnapshot>((requestId) => ({ type: 'viewport', requestId }));
  }

  buffer(range?: TerminalBufferRange): Promise<TerminalBufferSnapshot> {
    return this.request<TerminalBufferSnapshot>((requestId) => ({
      type: 'buffer',
      requestId,
      ...(range ? { range } : {}),
    }));
  }

  loadFont(face: TerminalFontFace): Promise<void> {
    const source = typeof face.source === 'string' ? face.source : face.source.slice(0);
    return this.request<void>(
      (requestId) => ({ type: 'loadFont', requestId, face: { ...face, source } }),
      typeof source === 'string' ? [] : [source]
    );
  }

  restore(data: Uint8Array): Promise<void> {
    const value = data.slice().buffer;
    return this.request<void>(
      (requestId) => ({ type: 'restore', requestId, data: value }),
      [value]
    );
  }

  setTheme(theme: TerminalTheme): Promise<void> {
    return this.request<void>((requestId) => ({ type: 'theme', requestId, theme }));
  }

  setScrollbackLines(lines: number): void {
    this.post({ type: 'scrollback', lines });
  }

  setDefaultCursor(style: import('./core/types.js').CursorStyle, blink: boolean): void {
    this.post({ type: 'defaultCursor', style, blink });
  }

  setAccessibility(enabled: boolean): void {
    this.post({ type: 'accessibility', enabled });
  }

  setMinimumContrastRatio(ratio: number): void {
    this.post({ type: 'minimumContrast', ratio });
  }

  reset(): void {
    this.post({ type: 'reset' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.post({ type: 'dispose' });
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.releaseWorker();
    for (const request of this.pending.values()) request.reject(new Error('Terminal disposed'));
    this.pending.clear();
  }

  private receive(message: WorkerToMainMessage, events: BackendEvents): void {
    if (this.failure || this.disposed) return;
    if (message.type === 'input')
      events.input(new Uint8Array(message.data), message.source as InputSource);
    else if (message.type === 'event') events.event(message.name, message.value);
    else if (message.type === 'a11y') events.a11y(message.rows);
    else if (message.type === 'rendered') events.rendered(message.state);
    else if (message.type === 'selection') this.resolve(message.requestId, message.value);
    else if (message.type === 'snapshot') this.resolve(message.requestId, message.value);
    else if (message.type === 'viewport') this.resolve(message.requestId, message.value);
    else if (message.type === 'buffer') this.resolve(message.requestId, message.value);
    else if (message.type === 'fontLoaded') this.resolve(message.requestId, undefined);
    else if (message.type === 'written') this.resolve(message.requestId, undefined);
    else if (message.type === 'restored') this.resolve(message.requestId, undefined);
    else if (message.type === 'themed') this.resolve(message.requestId, undefined);
    else if (message.type === 'clipboardEnabled') this.resolve(message.requestId, undefined);
    else if (message.type === 'clipboardPasted') this.resolve(message.requestId, message.value);
    else if (message.type === 'error') {
      const error = new Error(message.message);
      if (message.stack) error.stack = message.stack;
      if (message.requestId === undefined) events.error(error);
      else this.reject(message.requestId, error);
    }
  }

  private request<T>(
    message: (requestId: number) => MainToWorkerPayload,
    transfer: Transferable[] = []
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Terminal disposed'));
    if (this.failure) return Promise.reject(this.failure);
    const requestId = this.nextRequest++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.post(message(requestId), transfer);
    });
  }

  private resolve(requestId: number, value: unknown): void {
    const request = this.pending.get(requestId);
    this.pending.delete(requestId);
    request?.resolve(value);
  }

  private reject(requestId: number, error: Error): void {
    const request = this.pending.get(requestId);
    this.pending.delete(requestId);
    request?.reject(error);
  }

  private post(message: MainToWorkerPayload, transfer: Transferable[] = []): void {
    if (this.failure || (this.disposed && message.type !== 'dispose')) return;
    this.worker.postMessage({ ...message, terminalId: this.terminalId }, transfer);
  }

  private fail(error: Error, events: BackendEvents): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    events.error(error);
  }
}

class LocalBackend implements Backend {
  readonly renderer: RendererInfo;
  private renderPending = false;
  private readonly renderWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }> = [];
  private readonly runtime: CoreRuntime;
  private readonly terminal: CoreTerminal;
  private readonly painter: HybridRenderer;
  private readonly events: BackendEvents;
  private accessibility: boolean;
  private clipboardRegistration: Disposable | null = null;

  private constructor(
    runtime: CoreRuntime,
    terminal: CoreTerminal,
    painter: HybridRenderer,
    events: BackendEvents,
    accessibility: boolean
  ) {
    this.runtime = runtime;
    this.terminal = terminal;
    this.painter = painter;
    this.events = events;
    this.accessibility = accessibility;
    this.renderer = painter.info;
  }

  static async create(
    dom: TerminalDom,
    layout: Layout,
    options: TerminalOptions,
    events: BackendEvents
  ): Promise<LocalBackend> {
    const runtime = await createCoreRuntime({
      ...(options.wasm ? { wasm: options.wasm } : {}),
      ...(options.callbacksWasm ? { callbacksWasm: options.callbacksWasm } : {}),
    });
    const terminal = runtime.createTerminal({
      cols: layout.cols,
      rows: layout.rows,
      cellWidthPx: layout.metrics.cellWidth,
      cellHeightPx: layout.metrics.cellHeight,
      ...(options.scrollbackLines === undefined
        ? {}
        : { scrollbackLines: options.scrollbackLines }),
      ...(options.theme ? { theme: options.theme } : {}),
      ...(options.defaultCursorStyle ? { defaultCursorStyle: options.defaultCursorStyle } : {}),
      ...(options.defaultCursorBlink === undefined
        ? {}
        : { defaultCursorBlink: options.defaultCursorBlink }),
    });
    const painter = await HybridRenderer.create(
      dom.background,
      dom.text,
      layout.metrics,
      options.renderer ?? 'auto',
      options.allowTransparency ?? false,
      options.minimumContrastRatio ?? 1
    );
    const backend = new LocalBackend(
      runtime,
      terminal,
      painter,
      events,
      options.accessibility === 'full'
    );
    terminal.on('input', ({ data, source }) => events.input(data, source));
    for (const name of [
      'bell',
      'title',
      'cwd',
      'notification',
      'progress',
      'clipboardWrite',
    ] as const) {
      terminal.on(name, (value) => events.event(name, value));
    }
    terminal.on('error', events.error);
    backend.scheduleRender();
    return backend;
  }

  write(data: Uint8Array): void {
    this.terminal.write(data);
    this.scheduleRender();
  }
  async writeAsync(data: Uint8Array): Promise<void> {
    this.terminal.write(data);
    await this.scheduleRender();
  }
  resize(cols: number, rows: number, metrics: RenderMetrics): void {
    this.terminal.resize(cols, rows, metrics.cellWidth, metrics.cellHeight);
    this.painter.resize(metrics);
    this.scheduleRender();
  }
  key(input: KeyInput): void {
    this.terminal.key(input);
  }
  pointer(input: PointerInput): void {
    this.terminal.pointer(input);
    this.scheduleRender();
  }
  wheel(input: PointerInput, lines: number): void {
    this.terminal.wheel(input, lines);
    this.scheduleRender();
  }
  text(data: string): void {
    this.terminal.text(data);
  }
  paste(data: string): void {
    this.terminal.paste(data);
  }
  async enableClipboard(options: ClipboardProtocolOptions): Promise<void> {
    if (this.clipboardRegistration) throw new Error('Clipboard protocol is already enabled');
    this.clipboardRegistration = this.terminal.enableClipboard(options);
  }
  disableClipboard(): void {
    this.clipboardRegistration?.dispose();
    this.clipboardRegistration = null;
  }
  async pasteClipboard(request: ClipboardPasteRequest): Promise<ClipboardPasteResult> {
    return this.terminal.pasteClipboard(request);
  }
  focus(focused: boolean): void {
    this.terminal.focus(focused);
    this.painter.setFocused(focused);
  }
  scroll(delta: number | 'top' | 'bottom'): void {
    if (delta === 'top') this.terminal.scrollToTop();
    else if (delta === 'bottom') this.terminal.scrollToBottom();
    else this.terminal.scrollLines(delta);
    this.scheduleRender();
  }
  selectAll(): void {
    this.terminal.selectAll();
    this.scheduleRender();
  }
  clearSelection(): void {
    this.terminal.clearSelection();
    this.scheduleRender();
  }
  async getSelection(): Promise<string> {
    return this.terminal.getSelection();
  }
  async snapshot(): Promise<Uint8Array> {
    return this.terminal.snapshot();
  }
  async viewport(): Promise<ViewportSnapshot> {
    if (this.renderPending) await this.scheduleRender();
    return this.terminal.viewport();
  }
  async buffer(range?: TerminalBufferRange): Promise<TerminalBufferSnapshot> {
    if (this.renderPending) await this.scheduleRender();
    return this.terminal.readBuffer(range);
  }
  async loadFont(_face: TerminalFontFace): Promise<void> {}
  async restore(data: Uint8Array): Promise<void> {
    this.terminal.restore(data);
    this.scheduleRender();
  }
  async setTheme(theme: TerminalTheme): Promise<void> {
    await this.terminal.setTheme(theme);
    await this.scheduleRender();
  }
  setScrollbackLines(lines: number): void {
    this.terminal.setScrollbackLines(lines);
    this.scheduleRender();
  }
  setDefaultCursor(style: import('./core/types.js').CursorStyle, blink: boolean): void {
    this.terminal.setDefaultCursor(style, blink);
    this.scheduleRender();
  }
  setAccessibility(enabled: boolean): void {
    this.accessibility = enabled;
  }
  setMinimumContrastRatio(ratio: number): void {
    this.painter.setMinimumContrastRatio(ratio);
  }
  reset(): void {
    this.terminal.reset();
    this.scheduleRender();
  }
  dispose(): void {
    for (const waiter of this.renderWaiters.splice(0))
      waiter.reject(new Error('Terminal disposed'));
    this.disableClipboard();
    this.painter.dispose();
    this.runtime.dispose();
  }

  private scheduleRender(): Promise<void> {
    const rendered = new Promise<void>((resolve, reject) =>
      this.renderWaiters.push({ resolve, reject })
    );
    // Most mutations schedule opportunistically; keep their disposal rejection observed while
    // preserving rejection for callers that explicitly await the returned boundary.
    void rendered.catch(() => undefined);
    if (this.renderPending) return rendered;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      try {
        const frame = this.terminal.render();
        this.painter.render(frame);
        this.events.rendered(this.terminal.bufferState());
        if (this.accessibility) {
          const viewport = this.terminal.viewport();
          this.events.a11y(viewport.viewportRows.map((row) => row.text));
        }
        for (const waiter of this.renderWaiters.splice(0)) waiter.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const waiter of this.renderWaiters.splice(0)) waiter.reject(failure);
        this.events.error(failure);
      }
    });
    return rendered;
  }
}

/**
 * Browser terminal combining Ghostty VT state, worker isolation, rendering, DOM input, and PTY
 * streams.
 *
 * @remarks
 * Create terminals through {@link createTerminal}. The terminal owns every resource activated
 * through it and releases those resources together through {@link GespenstTerminal.dispose}.
 *
 * @example Minimal browser terminal
 * ```ts
 * const terminal = await createTerminal({ container });
 * terminal.write('\x1b[32mready\x1b[0m\r\n');
 * terminal.focus();
 * ```
 */
export class GespenstTerminal implements BrowserTerminal {
  /** Root DOM element owned by the terminal. */
  readonly element: HTMLElement;
  /** Active renderer and shaping implementation. */
  readonly renderer: RendererInfo;
  private readonly backend: Backend;
  private readonly dom: TerminalDom;
  private readonly options: TerminalOptions;
  private font: TerminalFontOptions;
  private readonly events: TypedEventEmitter<BrowserTerminalEventMap>;
  private readonly resizeObserver: ResizeObserver;
  private layout: Layout;
  private geometryValue: TerminalGeometry;
  private viewportState: TerminalBufferState | null = null;
  private wheelRemainderRows = 0;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];
  private readonly connections = new Set<TerminalConnection>();
  private readonly addons: TerminalAddon[] = [];
  private readonly fontFaces = new Set<FontFace>();
  private themeValue: TerminalTheme;
  private clipboardToken = 0;
  private clipboardActive = false;

  private constructor(
    dom: TerminalDom,
    backend: Backend,
    layout: Layout,
    options: TerminalOptions,
    events: TypedEventEmitter<BrowserTerminalEventMap>
  ) {
    this.dom = dom;
    this.backend = backend;
    this.layout = layout;
    this.geometryValue = geometryFromLayout(layout);
    this.options = options;
    this.themeValue = cloneTerminalTheme(options.theme ?? {});
    this.font = {
      family: options.fontFamily ?? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      sizePx: options.fontSizePx ?? 14,
      lineHeight: options.lineHeight ?? 1.25,
      weight: options.fontWeight ?? 400,
      boldWeight: options.fontWeightBold ?? 700,
      letterSpacingPx: options.letterSpacingPx ?? 0,
    };
    this.events = events;
    this.element = dom.root;
    this.renderer = backend.renderer;
    this.applyInputFont();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(dom.root);
    this.bindDom();
    this.applyThemeToDom();
  }

  /**
   * Creates and asynchronously initializes a browser terminal.
   *
   * @remarks
   * The returned promise resolves after WASM, font readiness, execution context, and renderer
   * initialization. If initialization fails, any inserted terminal root is removed.
   */
  static async create(options: TerminalOptions): Promise<GespenstTerminal> {
    assertThemeTransparency(options.theme ?? {}, options.allowTransparency ?? false);
    const dom = buildDom(options);
    options.container?.append(dom.root);
    try {
      const ownerDocument = terminalDocument(options);
      await ownerDocument.fonts?.load(
        `${options.fontWeight ?? 400} ${options.fontSizePx ?? 14}px ${options.fontFamily ?? 'monospace'}`
      );
      const layout = measure(dom, options);
      applyCanvasLayout(dom, layout);
      const events = new TypedEventEmitter<BrowserTerminalEventMap>();
      let terminal: GespenstTerminal | null = null;
      const backendEvents: BackendEvents = {
        input(data, source) {
          events.emit('input', { data, source });
        },
        event(name, value) {
          events.emit(name, value as never);
        },
        a11y(rows) {
          terminal?.updateAccessibility(rows);
        },
        rendered(state) {
          terminal?.handleRendered(state);
        },
        error(error) {
          events.emit('error', error);
        },
      };
      const canUseWorker =
        options.worker !== false &&
        typeof Worker !== 'undefined' &&
        'transferControlToOffscreen' in HTMLCanvasElement.prototype;
      const backend = canUseWorker
        ? await WorkerBackend.create(dom, layout, options, backendEvents)
        : await LocalBackend.create(dom, layout, options, backendEvents);
      terminal = new GespenstTerminal(dom, backend, layout, options, events);
      events.emit('renderer', backend.renderer);
      return terminal;
    } catch (error) {
      dom.root.remove();
      throw error;
    }
  }

  /** Current character-grid and backing-surface geometry. */
  get geometry(): TerminalGeometry {
    return this.geometryValue;
  }

  /** Current authored theme. Missing values inherit from `DEFAULT_THEME`. */
  get theme(): Readonly<TerminalTheme> {
    return this.themeValue;
  }

  /** Mounts a terminal created without a container and recalculates its layout. */
  async open(container: HTMLElement): Promise<void> {
    this.ensureActive();
    container.append(this.dom.root);
    await this.element.ownerDocument.fonts?.ready;
    this.fit();
  }

  /** Queues terminal output for VT parsing without waiting for the next rendered frame. */
  write(data: string | Uint8Array): void {
    this.ensureActive();
    this.backend.write(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    this.events.emit('bufferChange', { reason: 'write' });
  }

  /** Parses and renders terminal output before resolving. */
  async writeAsync(data: string | Uint8Array): Promise<void> {
    this.ensureActive();
    await this.backend.writeAsync(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    this.ensureActive();
    this.events.emit('writeParsed', undefined);
    this.events.emit('bufferChange', { reason: 'write' });
  }

  /** Encodes a physical keyboard input toward the PTY. */
  sendKey(input: KeyInput): void {
    this.ensureActive();
    this.backend.key(input);
  }
  /** Encodes a pointer input or updates terminal selection. */
  sendPointer(input: PointerInput): void {
    this.ensureActive();
    this.backend.pointer(input);
    if (input.action === 'release') this.events.emit('selectionChange', undefined);
  }
  /** Sends composed text toward the PTY. */
  sendText(data: string): void {
    this.ensureActive();
    this.backend.text(data);
  }
  /** Sends text through bracketed-paste handling when enabled. */
  paste(data: string): void {
    this.ensureActive();
    this.backend.paste(data);
  }

  /**
   * Enables the optional Kitty clipboard protocol bridge for one addon.
   *
   * @internal Addon authors should prefer `@gespenst/clipboard`.
   */
  async enableClipboard(options: ClipboardProtocolOptions = {}): Promise<Disposable> {
    this.ensureActive();
    if (this.clipboardActive) throw new Error('Clipboard protocol is already enabled');
    this.clipboardActive = true;
    const token = ++this.clipboardToken;
    try {
      await this.backend.enableClipboard(options);
      this.ensureActive();
    } catch (error) {
      if (this.clipboardToken === token) this.clipboardActive = false;
      throw error;
    }
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.clipboardToken !== token || !this.clipboardActive) return;
        this.clipboardActive = false;
        if (!this.disposed) this.backend.disableClipboard();
      },
    };
  }

  /** Delivers a user-authorized browser clipboard snapshot to Ghostty. */
  pasteClipboard(request: ClipboardPasteRequest): Promise<ClipboardPasteResult> {
    this.ensureActive();
    if (!this.clipboardActive)
      return Promise.reject(new Error('Clipboard protocol is not enabled'));
    return this.backend.pasteClipboard(request);
  }
  /** Focuses the hidden terminal input. */
  focus(): void {
    this.ensureActive();
    this.dom.input.focus({ preventScroll: true });
  }
  /** Removes focus from the hidden terminal input. */
  blur(): void {
    this.dom.input.blur();
  }

  /**
   * Fits to the container or applies an explicit character-grid size.
   *
   * @remarks Calling without both dimensions respects fixed `cols` and `rows` creation options.
   * Use {@link GespenstTerminal.fit} to force container measurement.
   */
  resize(cols?: number, rows?: number): void {
    if (this.disposed) return;
    const layout =
      cols === undefined || rows === undefined
        ? measure(this.dom, this.currentOptions())
        : layoutForGrid(this.layout.metrics, cols, rows);
    this.applyLayout(layout);
  }

  /** Recalculates terminal geometry from its current container, ignoring fixed initial grid values. */
  fit(): void {
    if (this.disposed) return;
    this.applyLayout(measure(this.dom, this.currentOptions(), true));
  }

  private applyLayout(layout: Layout): void {
    if (
      layout.cols === this.layout.cols &&
      layout.rows === this.layout.rows &&
      sameRenderMetrics(layout.metrics, this.layout.metrics)
    )
      return;
    const gridChanged = layout.cols !== this.layout.cols || layout.rows !== this.layout.rows;
    const geometry = geometryFromLayout(layout);
    applyCanvasLayout(this.dom, layout, this.backend instanceof WorkerBackend);
    this.backend.resize(layout.cols, layout.rows, layout.metrics);
    this.layout = layout;
    if (gridChanged) this.events.emit('bufferChange', { reason: 'resize' });
    if (!sameGeometry(this.geometryValue, geometry)) {
      this.geometryValue = geometry;
      this.events.emit('resize', geometry);
    }
  }

  /** Scrolls the viewport by a signed row count. */
  scrollLines(delta: number): void {
    this.backend.scroll(Math.trunc(delta));
  }
  /** Scrolls to the beginning of the buffer. */
  scrollToTop(): void {
    this.backend.scroll('top');
  }
  /** Scrolls to the end of the buffer. */
  scrollToBottom(): void {
    this.backend.scroll('bottom');
  }
  /** Selects all terminal buffer content. */
  selectAll(): void {
    this.backend.selectAll();
    this.events.emit('selectionChange', undefined);
  }
  /** Clears the active text selection. */
  clearSelection(): void {
    this.backend.clearSelection();
    this.events.emit('selectionChange', undefined);
  }
  /** Reads selected text. */
  getSelection(): Promise<string> {
    return this.backend.getSelection();
  }
  /** Serializes terminal state into Ghostty snapshot bytes. */
  snapshot(): Promise<Uint8Array> {
    return this.backend.snapshot();
  }
  /** Restores terminal state from compatible snapshot bytes. */
  async restore(snapshot: Uint8Array): Promise<void> {
    this.ensureActive();
    await this.backend.restore(snapshot);
    this.ensureActive();
    this.backend.resize(this.layout.cols, this.layout.rows, this.layout.metrics);
    this.events.emit('bufferChange', { reason: 'restore' });
  }
  /** Resets terminal state to initial values. */
  reset(): void {
    this.ensureActive();
    this.backend.reset();
    this.events.emit('bufferChange', { reason: 'reset' });
  }
  /** Reads a complete visible viewport snapshot. */
  readViewport(): Promise<ViewportSnapshot> {
    this.ensureActive();
    return this.backend.viewport();
  }
  /** Reads retained active-buffer rows without reparsing terminal output. */
  readBuffer(range?: TerminalBufferRange): Promise<TerminalBufferSnapshot> {
    this.ensureActive();
    return this.backend.buffer(range);
  }
  /**
   * Loads a font face in the document and active rendering backend.
   *
   * @remarks Loading a face does not select it. Follow with {@link GespenstTerminal.setFont} when the
   * terminal should use the new family.
   */
  async loadFont(face: TerminalFontFace): Promise<void> {
    this.ensureActive();
    const workerSource = typeof face.source === 'string' ? face.source : face.source.slice(0);
    const loaded = await new FontFace(face.family, face.source, face.descriptors).load();
    this.ensureActive();
    this.element.ownerDocument.fonts.add(loaded);
    this.fontFaces.add(loaded);
    await this.backend.loadFont({ ...face, source: workerSource });
  }
  /** Applies font values and returns recalculated terminal geometry. */
  async setFont(options: Partial<TerminalFontOptions>): Promise<TerminalGeometry> {
    this.ensureActive();
    this.font = { ...this.font, ...options };
    this.applyInputFont();
    await this.element.ownerDocument.fonts?.load(
      `${this.font.weight} ${this.font.sizePx}px ${this.font.family}`
    );
    this.fit();
    this.events.emit('font', this.geometryValue);
    return this.geometryValue;
  }

  /** Changes the maximum retained scrollback lines. */
  setScrollbackLines(lines: number): void {
    this.ensureActive();
    this.backend.setScrollbackLines(Math.max(0, Math.min(0xffff_ffff, Math.floor(lines))));
    this.events.emit('bufferChange', { reason: 'scrollback' });
  }

  /** Changes Ghostty's default cursor shape and blink behavior. */
  setDefaultCursor(style: import('./core/types.js').CursorStyle, blink: boolean): void {
    this.ensureActive();
    this.backend.setDefaultCursor(style, blink);
  }

  /** Changes the browser accessibility mirror level. */
  setAccessibility(level: 'off' | 'basic' | 'full'): void {
    this.ensureActive();
    const full = level === 'full';
    if (full) {
      this.dom.a11y.setAttribute('role', 'log');
      this.dom.a11y.removeAttribute('aria-hidden');
    } else {
      this.dom.a11y.removeAttribute('role');
      this.dom.a11y.setAttribute('aria-hidden', 'true');
      this.dom.a11y.replaceChildren();
    }
    this.backend.setAccessibility(full);
  }

  /** Changes the renderer's minimum contrast ratio. */
  setMinimumContrastRatio(ratio: number): void {
    this.ensureActive();
    this.backend.setMinimumContrastRatio(ratio);
  }
  /** Replaces the terminal color theme. */
  async setTheme(theme: TerminalTheme): Promise<void> {
    this.ensureActive();
    assertThemeTransparency(theme, this.options.allowTransparency ?? false);
    const next = cloneTerminalTheme(theme);
    await this.backend.setTheme(next);
    this.ensureActive();
    this.themeValue = next;
    this.applyThemeToDom();
  }

  /** Patches the current terminal color theme. */
  updateTheme(theme: TerminalTheme): Promise<void> {
    return this.setTheme(mergeTerminalTheme(this.themeValue, theme));
  }

  /** Activates an addon and owns it until terminal disposal. */
  loadAddon(addon: TerminalAddon): void {
    this.ensureActive();
    this.addons.push(addon);
    addon.activate(this);
  }

  /** Subscribes to a typed browser terminal event. */
  on<Key extends keyof BrowserTerminalEventMap>(
    type: Key,
    listener: (value: BrowserTerminalEventMap[Key]) => void
  ): Disposable {
    return this.events.on(type, listener);
  }

  /**
   * Connects terminal output and input to bidirectional PTY byte streams.
   *
   * @remarks
   * Incoming chunks are awaited through {@link GespenstTerminal.writeAsync}. Outgoing input is
   * copied into a bounded queue whose default limit is 1 MiB. Geometry is intentionally separate;
   * subscribe to `resize` and forward columns and rows through the backend's control protocol.
   */
  connect(
    transport: TerminalTransport,
    options: TerminalConnectionOptions = {}
  ): TerminalConnection {
    this.ensureActive();
    const abort = new AbortController();
    const reader = transport.readable.getReader();
    const writer = transport.writable.getWriter();
    const statuses = new TypedEventEmitter<{ status: TerminalConnectionStatus }>();
    const highWaterMark = options.highWaterMarkBytes ?? 1024 * 1024;
    let status: TerminalConnectionStatus = 'connecting';
    let connectionError: Error | undefined;
    let intentionalClose = false;
    let settled = false;
    let queuedBytes = 0;
    let writes = Promise.resolve();
    const setStatus = (value: TerminalConnectionStatus) => {
      if (status === value) return;
      status = value;
      statuses.emit('status', value);
    };
    const fail = (error: unknown) => {
      if (connectionError || intentionalClose || settled) return;
      connectionError = error instanceof Error ? error : new Error(String(error));
      setStatus('error');
      this.events.emit('error', connectionError);
      abort.abort(connectionError);
      void reader.cancel(connectionError).catch(() => undefined);
      void writer.abort(connectionError).catch(() => undefined);
    };
    const input = this.on('input', ({ data }) => {
      if (abort.signal.aborted) return;
      if (queuedBytes + data.byteLength > highWaterMark) {
        fail(new Error(`Terminal input queue exceeded ${highWaterMark} bytes`));
        return;
      }
      const value = data.slice();
      queuedBytes += value.byteLength;
      writes = writes
        .then(() => writer.write(value))
        .catch(fail)
        .finally(() => {
          queuedBytes -= value.byteLength;
        });
    });
    let settleClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<void>((resolve, reject) => {
      settleClosed = resolve;
      rejectClosed = reject;
    });
    const connection: TerminalConnection = {
      get status() {
        return status;
      },
      get error() {
        return connectionError;
      },
      closed,
      onStatusChange(listener) {
        return statuses.on('status', listener);
      },
      async close(reason) {
        if (status === 'closed' || status === 'error') return closed;
        intentionalClose = true;
        setStatus('closing');
        abort.abort(reason);
        await Promise.all([
          reader.cancel(reason).catch(() => undefined),
          writer.abort(reason).catch(() => undefined),
        ]);
        return closed;
      },
      dispose() {
        void this.close('Connection disposed');
      },
    };
    this.connections.add(connection);
    const externalAbort = () => void connection.close(options.signal?.reason);
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) externalAbort();
    void (async () => {
      try {
        if (!abort.signal.aborted) setStatus('open');
        let readableEnded = false;
        while (!abort.signal.aborted) {
          const result = await reader.read();
          if (result.done) {
            readableEnded = true;
            break;
          }
          await this.writeAsync(result.value);
        }
        if (readableEnded && !abort.signal.aborted) input.dispose();
        await writes;
        if (connectionError) throw connectionError;
        if (readableEnded && !abort.signal.aborted) await writer.close();
      } catch (error) {
        if (!intentionalClose) fail(error);
      } finally {
        settled = true;
        input.dispose();
        options.signal?.removeEventListener('abort', externalAbort);
        reader.releaseLock();
        writer.releaseLock();
        this.connections.delete(connection);
        if (connectionError) rejectClosed(connectionError);
        else {
          setStatus('closed');
          settleClosed();
        }
        statuses.clear();
      }
    })();
    return connection;
  }

  /** Releases transports, addons, fonts, workers, renderers, events, and DOM resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clipboardActive = false;
    this.resizeObserver.disconnect();
    for (const connection of [...this.connections]) connection.dispose();
    for (const addon of this.addons.splice(0).reverse()) addon.dispose();
    for (const face of this.fontFaces) this.element.ownerDocument.fonts.delete(face);
    this.fontFaces.clear();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.backend.dispose();
    this.events.clear();
    this.dom.root.remove();
  }

  private bindDom(): void {
    const { root, input } = this.dom;
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions
    ) => {
      target.addEventListener(type, listener as EventListener, options);
      this.cleanups.push(() =>
        target.removeEventListener(type, listener as EventListener, options)
      );
    };
    listen(root, 'pointerdown', () => this.focus());
    listen(root, 'pointerdown', (event) => {
      root.setPointerCapture(event.pointerId);
      this.sendPointer(pointerInput(event, 'press', this.layout));
      event.preventDefault();
    });
    listen(root, 'pointermove', (event) => {
      this.sendPointer(pointerInput(event, 'motion', this.layout));
    });
    listen(root, 'pointerup', (event) => {
      this.sendPointer(pointerInput(event, 'release', this.layout));
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      event.preventDefault();
    });
    listen(
      root,
      'wheel',
      (event) => {
        event.preventDefault();
        if (event.deltaY === 0) return;
        const cellHeightCss = this.layout.metrics.cellHeight / this.layout.metrics.devicePixelRatio;
        const deltaRows =
          event.deltaMode === 1
            ? event.deltaY
            : event.deltaMode === 2
              ? event.deltaY * this.layout.rows
              : event.deltaY / cellHeightCss;
        this.wheelRemainderRows += deltaRows;
        const lines = Math.trunc(this.wheelRemainderRows);
        if (lines === 0) return;
        this.wheelRemainderRows -= lines;
        const point = pointerInput(event, 'press', this.layout);
        this.backend.wheel({ ...point, button: lines < 0 ? 'four' : 'five' }, lines);
      },
      { passive: false }
    );
    listen(input, 'focus', () => this.backend.focus(true));
    listen(input, 'blur', () => this.backend.focus(false));
    listen(input, 'keydown', (event) => this.handleKeyDown(event));
    listen(input, 'keyup', (event) => {
      this.backend.key({ code: event.code, action: 'release', modifiers: modifiers(event) });
      event.preventDefault();
    });
    listen(input, 'paste', (event) => {
      const value = event.clipboardData?.getData('text/plain');
      if (value !== undefined) this.paste(value);
      event.preventDefault();
    });
    let composing = false;
    let compositionCommit = '';
    listen(input, 'compositionstart', () => {
      composing = true;
      compositionCommit = '';
    });
    listen(input, 'input', () => {
      if (composing) return;
      if (compositionCommit && input.value === compositionCommit) {
        compositionCommit = '';
        input.value = '';
        return;
      }
      if (input.value) this.sendText(input.value);
      input.value = '';
    });
    listen(input, 'compositionend', (event) => {
      composing = false;
      compositionCommit = event.data;
      if (event.data) this.sendText(event.data);
      input.value = '';
    });
  }

  private handleRendered(state: TerminalBufferState): void {
    const previous = this.viewportState;
    this.viewportState = state;
    this.positionInputAtCursor(state);
    if (!previous || previous.viewportY !== state.viewportY) {
      this.events.emit('scroll', state.viewportY);
    }
    this.events.emit('viewportChange', { revision: state.revision, state });
  }

  private positionInputAtCursor(state: TerminalBufferState): void {
    const { cellWidth, cellHeight, devicePixelRatio } = this.layout.metrics;
    const cursorBufferRow = state.scrollbackRows + state.cursorY;
    const viewportRow = Math.max(
      0,
      Math.min(this.layout.rows - 1, cursorBufferRow - state.viewportY)
    );
    const column = Math.max(0, Math.min(this.layout.cols - 1, state.cursorX));
    const left = `${(column * cellWidth) / devicePixelRatio}px`;
    const top = `${(viewportRow * cellHeight) / devicePixelRatio}px`;
    if (this.dom.input.style.left !== left) this.dom.input.style.left = left;
    if (this.dom.input.style.top !== top) this.dom.input.style.top = top;
  }

  private applyInputFont(): void {
    this.dom.input.style.fontFamily = this.font.family;
    this.dom.input.style.fontSize = `${this.font.sizePx}px`;
    this.dom.input.style.lineHeight = `${this.font.sizePx * this.font.lineHeight}px`;
    this.dom.input.style.fontWeight = String(this.font.weight);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const copy =
      (event.metaKey && event.code === 'KeyC') ||
      (event.ctrlKey && event.shiftKey && event.code === 'KeyC');
    if (copy) {
      void this.getSelection().then((value) => {
        if (value) return navigator.clipboard.writeText(value);
      });
      event.preventDefault();
      return;
    }
    const paste =
      (event.metaKey && event.code === 'KeyV') ||
      (event.ctrlKey && event.shiftKey && event.code === 'KeyV');
    if (paste) return;
    const composed = composedCharacter(event);
    this.backend.key({
      code: event.code || 'Unidentified',
      action: event.repeat ? 'repeat' : 'press',
      modifiers:
        composed === undefined
          ? modifiers(event)
          : modifiers(event) & ~(KeyModifiers.alt | KeyModifiers.control),
      composing: event.isComposing,
      ...(composed === undefined
        ? event.key.length === 1
          ? { text: event.key }
          : {}
        : { text: composed }),
    });
    event.preventDefault();
  }

  private updateAccessibility(rows: readonly string[]): void {
    if ((this.options.accessibility ?? 'basic') !== 'full') return;
    this.dom.a11y.textContent = rows.join('\n');
  }

  private applyThemeToDom(): void {
    const theme = resolveTerminalTheme(this.themeValue);
    const root = this.dom.root;
    root.style.setProperty('--gespenst-terminal-background', terminalColorToCss(theme.background));
    root.style.setProperty('--gespenst-terminal-foreground', terminalColorToCss(theme.foreground));
    root.style.setProperty('--gespenst-terminal-cursor', terminalColorToCss(theme.cursor));
    root.style.setProperty(
      '--gespenst-terminal-selection-background',
      terminalColorToCss(theme.selectionBackground)
    );
    root.style.colorScheme = theme.appearance;
    root.style.color = terminalColorToCss(theme.foreground);
    root.style.backgroundColor = this.options.allowTransparency
      ? 'transparent'
      : terminalColorToCss(theme.background);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('GespenstTerminal is disposed');
  }

  private currentOptions(): TerminalOptions {
    return {
      ...this.options,
      fontFamily: this.font.family,
      fontSizePx: this.font.sizePx,
      lineHeight: this.font.lineHeight,
      fontWeight: this.font.weight,
      fontWeightBold: this.font.boldWeight,
      letterSpacingPx: this.font.letterSpacingPx,
    };
  }
}

function sameRenderMetrics(left: RenderMetrics, right: RenderMetrics): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.cellWidth === right.cellWidth &&
    left.cellHeight === right.cellHeight &&
    left.fontSize === right.fontSize &&
    left.fontFamily === right.fontFamily &&
    left.fontWeight === right.fontWeight &&
    left.fontWeightBold === right.fontWeightBold &&
    left.letterSpacing === right.letterSpacing &&
    left.devicePixelRatio === right.devicePixelRatio
  );
}

function assertThemeTransparency(theme: TerminalTheme, allowTransparency: boolean): void {
  if (allowTransparency) return;
  const resolved = resolveTerminalTheme(theme);
  const opaque = [
    ['foreground', resolved.foreground],
    ['background', resolved.background],
    ['cursor', resolved.cursor],
    ['cursorAccent', resolved.cursorAccent],
    ...resolved.palette.map((color, index) => [`palette[${index}]`, color] as const),
  ] as const;
  const transparent = opaque.find(([, color]) => color.a < 1);
  if (transparent) {
    throw new ThemeValidationError(
      transparent[0],
      'transparent terminal colors require allowTransparency: true'
    );
  }
}

/**
 * Creates and asynchronously initializes a browser terminal.
 *
 * @param options - Host, execution, renderer, layout, font, accessibility, and WASM options.
 * @returns A ready terminal whose initial geometry and renderer can be inspected immediately.
 *
 * @example
 * ```ts
 * const terminal = await createTerminal({
 *   container: document.querySelector<HTMLElement>('#terminal')!,
 * });
 * ```
 */
export function createTerminal(options: TerminalOptions): Promise<GespenstTerminal> {
  return GespenstTerminal.create(options);
}

function buildDom(options: TerminalOptions): TerminalDom {
  const ownerDocument = terminalDocument(options);
  const root = ownerDocument.createElement('div');
  root.className = 'gespenst';
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', options.ariaLabel ?? 'Terminal');
  const background = ownerDocument.createElement('canvas');
  background.className = 'gespenst__canvas gespenst__background';
  const text = ownerDocument.createElement('canvas');
  text.className = 'gespenst__canvas gespenst__text';
  const input = ownerDocument.createElement('textarea');
  input.className = 'gespenst__input';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Terminal input');
  const a11y = ownerDocument.createElement('div');
  a11y.className = 'gespenst__a11y';
  if ((options.accessibility ?? 'basic') === 'full') a11y.setAttribute('role', 'log');
  else a11y.setAttribute('aria-hidden', 'true');
  root.append(background, text, input, a11y);
  return { root, background, text, input, a11y };
}

function measure(dom: TerminalDom, options: TerminalOptions, fit = false): Layout {
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  const fontSizeCss = options.fontSizePx ?? 14;
  const lineHeightCss = fontSizeCss * (options.lineHeight ?? 1.25);
  const fontFamily =
    options.fontFamily ?? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const probe = terminalDocument(options).createElement('canvas').getContext('2d');
  if (!probe) throw new Error('Canvas 2D is required for font measurement');
  probe.font = `${options.fontWeight ?? 400} ${fontSizeCss}px ${fontFamily}`;
  const cellWidth = Math.max(
    1,
    Math.round((probe.measureText('M').width + (options.letterSpacingPx ?? 0)) * dpr)
  );
  const cellHeight = Math.max(1, Math.round(lineHeightCss * dpr));
  const cellWidthCss = cellWidth / dpr;
  const cellHeightCss = cellHeight / dpr;
  const bounds = dom.root.getBoundingClientRect();
  const cols = Math.max(
    1,
    (!fit ? options.cols : undefined) ??
      Math.floor((bounds.width || 80 * cellWidthCss) / cellWidthCss)
  );
  const rows = Math.max(
    1,
    (!fit ? options.rows : undefined) ??
      Math.floor((bounds.height || 24 * cellHeightCss) / cellHeightCss)
  );
  return {
    cols,
    rows,
    metrics: {
      width: cols * cellWidth,
      height: rows * cellHeight,
      cellWidth,
      cellHeight,
      fontSize: fontSizeCss * dpr,
      fontFamily,
      fontWeight: options.fontWeight ?? 400,
      fontWeightBold: options.fontWeightBold ?? 700,
      letterSpacing: (options.letterSpacingPx ?? 0) * dpr,
      devicePixelRatio: dpr,
    },
  };
}

function terminalDocument(options: TerminalOptions): Document {
  return options.documentOverride ?? options.container?.ownerDocument ?? document;
}

function layoutForGrid(metrics: RenderMetrics, cols: number, rows: number): Layout {
  const nextCols = Math.max(1, Math.min(65_535, Math.trunc(cols)));
  const nextRows = Math.max(1, Math.min(65_535, Math.trunc(rows)));
  return {
    cols: nextCols,
    rows: nextRows,
    metrics: {
      ...metrics,
      width: nextCols * metrics.cellWidth,
      height: nextRows * metrics.cellHeight,
    },
  };
}

function applyCanvasLayout(dom: TerminalDom, layout: Layout, transferred = false): void {
  for (const canvas of [dom.background, dom.text]) {
    canvas.style.width = `${layout.metrics.width / layout.metrics.devicePixelRatio}px`;
    canvas.style.height = `${layout.metrics.height / layout.metrics.devicePixelRatio}px`;
    if (!transferred) {
      canvas.width = layout.metrics.width;
      canvas.height = layout.metrics.height;
    }
  }
}

function geometryFromLayout(layout: Layout): TerminalGeometry {
  return Object.freeze({
    cols: layout.cols,
    rows: layout.rows,
    cellWidthPx: layout.metrics.cellWidth,
    cellHeightPx: layout.metrics.cellHeight,
    widthPx: layout.metrics.width,
    heightPx: layout.metrics.height,
  });
}

function sameGeometry(left: TerminalGeometry, right: TerminalGeometry): boolean {
  return (
    left.cols === right.cols &&
    left.rows === right.rows &&
    left.cellWidthPx === right.cellWidthPx &&
    left.cellHeightPx === right.cellHeightPx &&
    left.widthPx === right.widthPx &&
    left.heightPx === right.heightPx
  );
}

/**
 * The character a layout composes with AltGr, or with Option on macOS, arrives as a printable
 * `key` while Alt — and on Windows and Linux, Ctrl — is still held. Encoding that as a modified
 * key emits an escape sequence instead of the character, which leaves `|`, `@`, `~`, `\\` and `{}`
 * untypeable on the many layouts that compose them. A key whose character is its own unmodified
 * character, such as Alt+B, is left alone so it still reaches the application as meta.
 */
function composedCharacter(event: KeyboardEvent): string | undefined {
  if (event.key.length !== 1 || event.metaKey) return undefined;
  if (!event.altKey && !event.getModifierState('AltGraph')) return undefined;
  const base = unmodifiedCharacter(event.code);
  if (base !== undefined && event.key.toLowerCase() === base) return undefined;
  return event.key;
}

/** The character a key produces on its own, for the codes whose character the code itself names. */
function unmodifiedCharacter(code: string): string | undefined {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  return undefined;
}

function modifiers(event: KeyboardEvent): number {
  return (
    (event.shiftKey ? KeyModifiers.shift : 0) |
    (event.ctrlKey ? KeyModifiers.control : 0) |
    (event.altKey ? KeyModifiers.alt : 0) |
    (event.metaKey ? KeyModifiers.meta : 0) |
    (event.getModifierState('CapsLock') ? KeyModifiers.capsLock : 0) |
    (event.getModifierState('NumLock') ? KeyModifiers.numLock : 0)
  );
}

function pointerInput(
  event: PointerEvent | WheelEvent,
  action: PointerInput['action'],
  layout: Layout
): PointerInput {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const x = (event.clientX - bounds.left) * layout.metrics.devicePixelRatio;
  const y = (event.clientY - bounds.top) * layout.metrics.devicePixelRatio;
  const buttonNames: readonly MouseButton[] = ['left', 'middle', 'right', 'four', 'five'];
  return {
    action,
    x,
    y,
    anyButtonPressed: 'buttons' in event && event.buttons !== 0,
    forceSelection: event.shiftKey,
    rectangle: event.altKey,
    modifiers:
      (event.shiftKey ? KeyModifiers.shift : 0) |
      (event.ctrlKey ? KeyModifiers.control : 0) |
      (event.altKey ? KeyModifiers.alt : 0) |
      (event.metaKey ? KeyModifiers.meta : 0),
    ...(event.button >= 0 && buttonNames[event.button]
      ? { button: buttonNames[event.button] }
      : {}),
    timeMs: event.timeStamp,
  };
}

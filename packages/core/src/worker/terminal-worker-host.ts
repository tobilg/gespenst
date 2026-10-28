/// <reference lib="webworker" />

import {
  type CoreRuntime,
  type CoreTerminal,
  createCoreRuntime,
  type Disposable,
} from '../core/index.js';
import { coreBenchmarkTiming } from '../internal/benchmark.js';
import { RenderPipeline, startBenchmark } from '../internal/render-pipeline.js';
import {
  type MainToWorkerMessage,
  TERMINAL_PROTOCOL_VERSION,
  type WorkerEventName,
  type WorkerInitOptions,
  type WorkerToMainMessage,
  type WorkerToMainPayload,
} from '../protocol.js';
import { HybridRenderer, type RenderMetrics } from '../renderers/hybrid.js';

interface WorkerSession {
  readonly id: number;
  readonly terminal: CoreTerminal;
  readonly renderer: HybridRenderer;
  readonly pipeline: RenderPipeline;
  metrics: RenderMetrics;
  readonly fontFaces: FontFace[];
  clipboardRegistration: Disposable | null;
}

export interface TerminalWorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
  readonly fonts?: Pick<FontFaceSet, 'add' | 'delete'>;
}

export interface TerminalWorkerHostDependencies {
  readonly createRuntime: typeof createCoreRuntime;
  readonly createRenderer: typeof HybridRenderer.create;
  readonly loadFontFace: (
    family: string,
    source: string | ArrayBuffer,
    descriptors?: FontFaceDescriptors
  ) => Promise<FontFace>;
}

const DEFAULT_DEPENDENCIES: TerminalWorkerHostDependencies = {
  createRuntime: createCoreRuntime,
  createRenderer: HybridRenderer.create,
  loadFontFace: (family, source, descriptors) => new FontFace(family, source, descriptors).load(),
};

/** Stateful worker protocol host, separated from the worker bootstrap for deterministic testing. */
export class TerminalWorkerHost {
  private readonly scope: TerminalWorkerScope;
  private readonly dependencies: TerminalWorkerHostDependencies;
  private readonly sessions = new Map<number, WorkerSession>();
  private readonly initializingSessionIds = new Set<number>();
  private runtime: CoreRuntime | null = null;
  private runtimePromise: Promise<CoreRuntime> | null = null;
  private runtimeKey: number | null = null;
  private initializingSessions = 0;

  constructor(
    scope: TerminalWorkerScope,
    dependencies: TerminalWorkerHostDependencies = DEFAULT_DEPENDENCIES
  ) {
    this.scope = scope;
    this.dependencies = dependencies;
  }

  /** Handles a message and reports protocol failures through the worker error channel. */
  dispatch(message: MainToWorkerMessage): void {
    void this.handle(message).catch((error) =>
      this.reportError(
        message.terminalId,
        error,
        'requestId' in message ? message.requestId : undefined
      )
    );
  }

  /** Handles one worker protocol message, rejecting malformed session transitions. */
  async handle(message: MainToWorkerMessage): Promise<void> {
    if (message.type === 'init') return this.initialize(message);
    const session = this.sessions.get(message.terminalId);
    if (!session) throw new Error('The terminal worker session is not initialized');
    const terminal = session.terminal;

    if (message.type === 'write') {
      const benchmark = message.benchmark ? startBenchmark() : undefined;
      await session.pipeline.write(new Uint8Array(message.data), benchmark);
      if (message.requestId !== undefined) {
        this.post(session.id, {
          type: 'written',
          requestId: message.requestId,
          ...(benchmark ? { timing: coreBenchmarkTiming(benchmark) } : {}),
        });
      }
      return;
    }
    if (message.type === 'resize') {
      session.metrics = message.metrics;
      terminal.resize(
        message.cols,
        message.rows,
        message.metrics.cellWidth,
        message.metrics.cellHeight
      );
      session.renderer.resize(message.metrics);
    } else if (message.type === 'key') terminal.key(message.input);
    else if (message.type === 'pointer') terminal.pointer(message.input);
    else if (message.type === 'wheel') terminal.wheel(message.input, message.lines);
    else if (message.type === 'text') terminal.text(message.data);
    else if (message.type === 'paste') terminal.paste(message.data);
    else if (message.type === 'clipboardEnable') {
      if (session.clipboardRegistration) throw new Error('Clipboard protocol is already enabled');
      session.clipboardRegistration = terminal.enableClipboard(message.options);
      this.post(session.id, { type: 'clipboardEnabled', requestId: message.requestId });
      return;
    } else if (message.type === 'clipboardDisable') {
      session.clipboardRegistration?.dispose();
      session.clipboardRegistration = null;
      return;
    } else if (message.type === 'clipboardPaste') {
      const value = terminal.pasteClipboard({
        contents: message.request.contents.map(({ mime, data }) => ({
          mime,
          data: new Uint8Array(data),
        })),
        ...(message.request.location === undefined ? {} : { location: message.request.location }),
        ...(message.request.allowUnsafe === undefined
          ? {}
          : { allowUnsafe: message.request.allowUnsafe }),
      });
      this.post(session.id, { type: 'clipboardPasted', requestId: message.requestId, value });
      return;
    } else if (message.type === 'focus') {
      terminal.focus(message.focused);
      session.renderer.setFocused(message.focused);
    } else if (message.type === 'scroll') {
      if (message.delta === 'top') terminal.scrollToTop();
      else if (message.delta === 'bottom') terminal.scrollToBottom();
      else terminal.scrollLines(message.delta);
    } else if (message.type === 'selectAll') terminal.selectAll();
    else if (message.type === 'clearSelection') terminal.clearSelection();
    else if (message.type === 'getSelection') {
      this.post(session.id, {
        type: 'selection',
        requestId: message.requestId,
        value: terminal.getSelection(),
      });
    } else if (message.type === 'snapshot') {
      const value = transferable(terminal.snapshot());
      this.post(session.id, { type: 'snapshot', requestId: message.requestId, value }, [value]);
    } else if (message.type === 'viewport') {
      if (session.pipeline.pending) await session.pipeline.scheduleRender();
      this.post(session.id, {
        type: 'viewport',
        requestId: message.requestId,
        value: terminal.viewport(),
      });
      return;
    } else if (message.type === 'buffer') {
      if (session.pipeline.pending) await session.pipeline.scheduleRender();
      this.post(session.id, {
        type: 'buffer',
        requestId: message.requestId,
        value: terminal.readBuffer(message.range),
      });
      return;
    } else if (message.type === 'loadFont') {
      const loaded = await this.dependencies.loadFontFace(
        message.face.family,
        message.face.source,
        message.face.descriptors
      );
      this.scope.fonts?.add(loaded);
      session.fontFaces.push(loaded);
      this.post(session.id, { type: 'fontLoaded', requestId: message.requestId });
    } else if (message.type === 'reset') terminal.reset();
    else if (message.type === 'restore') {
      try {
        terminal.restore(new Uint8Array(message.data));
        this.post(session.id, { type: 'restored', requestId: message.requestId });
      } catch (error) {
        this.reportError(session.id, error, message.requestId);
      }
    } else if (message.type === 'theme') {
      await terminal.setTheme(message.theme);
      await session.pipeline.scheduleRender();
      this.post(session.id, { type: 'themed', requestId: message.requestId });
      return;
    } else if (message.type === 'scrollback') {
      terminal.setScrollbackLines(message.lines);
    } else if (message.type === 'defaultCursor') {
      terminal.setDefaultCursor(message.style, message.blink);
    } else if (message.type === 'accessibility') {
      session.pipeline.accessibility = message.enabled;
    } else if (message.type === 'minimumContrast') {
      session.renderer.setMinimumContrastRatio(message.ratio);
    } else if (message.type === 'dispose') {
      session.clipboardRegistration?.dispose();
      for (const face of session.fontFaces) this.scope.fonts?.delete(face);
      session.pipeline.dispose();
      session.renderer.dispose();
      terminal.dispose();
      this.sessions.delete(session.id);
      this.disposeUnusedRuntime();
      return;
    }
    session.pipeline.scheduleRender();
  }

  private async initialize(message: Extract<MainToWorkerMessage, { type: 'init' }>): Promise<void> {
    if (message.version !== TERMINAL_PROTOCOL_VERSION)
      throw new Error('Unsupported terminal protocol');
    if (
      this.sessions.has(message.terminalId) ||
      this.initializingSessionIds.has(message.terminalId)
    )
      throw new Error('Terminal worker session already exists');

    this.initializingSessionIds.add(message.terminalId);
    this.initializingSessions += 1;
    let terminal: CoreTerminal | null = null;
    try {
      const activeRuntime = await this.getRuntime(message.options);
      terminal = activeRuntime.createTerminal(message.options);
      const renderer = await this.dependencies.createRenderer(
        message.options.backgroundCanvases,
        message.options.textCanvas,
        message.options.metrics,
        message.options.renderer,
        message.options.allowTransparency,
        message.options.minimumContrastRatio
      );
      const id = message.terminalId;
      const pipeline = new RenderPipeline(
        terminal,
        renderer,
        {
          schedule: (callback) => {
            if (typeof this.scope.requestAnimationFrame === 'function')
              this.scope.requestAnimationFrame(callback);
            else queueMicrotask(callback);
          },
          isActive: () => this.sessions.get(id) === session,
          rendered: (state) => this.post(id, { type: 'rendered', state }),
          accessibilityRows: (rows) => this.post(id, { type: 'a11y', rows: [...rows] }),
          error: (error) => this.reportError(id, error),
        },
        message.options.accessibility
      );
      const session: WorkerSession = {
        id,
        terminal,
        renderer,
        pipeline,
        metrics: message.options.metrics,
        fontFaces: [],
        clipboardRegistration: null,
      };
      renderer.onRendererChange((info, surfaceIndex) =>
        this.post(session.id, { type: 'renderer', renderer: info, surfaceIndex })
      );
      renderer.onRendererError((error) => this.reportError(session.id, error));
      terminal = null;
      this.sessions.set(session.id, session);
      this.forwardEvents(session);
      this.post(session.id, {
        type: 'ready',
        renderer: renderer.info,
        surfaceIndex: renderer.surfaceIndex,
      });
      pipeline.scheduleRender();
    } finally {
      terminal?.dispose();
      this.initializingSessionIds.delete(message.terminalId);
      this.initializingSessions -= 1;
      this.disposeUnusedRuntime();
    }
  }

  private getRuntime(options: WorkerInitOptions): Promise<CoreRuntime> {
    if (this.runtimeKey !== null && this.runtimeKey !== options.runtimeKey)
      return Promise.reject(new Error('Shared worker terminals must use the same WASM sources'));
    if (this.runtime) return Promise.resolve(this.runtime);
    if (this.runtimePromise) return this.runtimePromise;

    this.runtimeKey = options.runtimeKey;
    this.runtimePromise = this.dependencies
      .createRuntime({
        ...(options.wasm ? { wasm: options.wasm } : {}),
        ...(options.callbacksWasm ? { callbacksWasm: options.callbacksWasm } : {}),
      })
      .then((value) => {
        this.runtime = value;
        this.runtimePromise = null;
        return value;
      })
      .catch((error: unknown) => {
        this.runtimePromise = null;
        this.runtimeKey = null;
        throw error;
      });
    return this.runtimePromise;
  }

  private disposeUnusedRuntime(): void {
    if (this.sessions.size !== 0 || this.initializingSessions !== 0 || !this.runtime) return;
    this.runtime.dispose();
    this.runtime = null;
    this.runtimeKey = null;
  }

  private forwardEvents(session: WorkerSession): void {
    session.terminal.on('input', ({ data, source }) => {
      const buffer = transferable(data);
      this.post(session.id, { type: 'input', data: buffer, source }, [buffer]);
    });
    for (const name of [
      'bell',
      'title',
      'cwd',
      'notification',
      'progress',
      'clipboardWrite',
    ] as const) {
      session.terminal.on(name, (value) =>
        this.post(session.id, { type: 'event', name: name as WorkerEventName, value })
      );
    }
    session.terminal.on('error', (error) => this.reportError(session.id, error));
  }

  private post(
    terminalId: number,
    message: WorkerToMainPayload,
    transfer: Transferable[] = []
  ): void {
    this.scope.postMessage({ ...message, terminalId }, transfer);
  }

  private reportError(terminalId: number, error: unknown, requestId?: number): void {
    const value = error instanceof Error ? error : new Error(String(error));
    this.post(terminalId, {
      type: 'error',
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

function transferable(data: Uint8Array): ArrayBuffer {
  return data.slice().buffer;
}

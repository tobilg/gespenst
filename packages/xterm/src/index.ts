import {
  ANSI_COLOR_NAMES,
  createTerminal,
  DEFAULT_CALLBACKS_URL,
  DEFAULT_WASM_URL,
  type GespenstTerminal,
  type TerminalOptions as NativeTerminalOptions,
  parseTerminalColor,
  preloadGhostty,
  type RenderCell,
  type RendererPreference,
  resolveTerminalTheme,
  type TerminalBufferState,
  type TerminalCursorAttributes,
  type TerminalTheme,
  terminalColorToCss,
} from '@gespenst/core';
import type {
  IBufferNamespace,
  IBufferRange,
  IDecoration,
  IDecorationOptions,
  IDisposable,
  ILink,
  ILinkProvider,
  ILocalizableStrings,
  IMarker,
  IModes,
  IParser,
  ITerminalAddon,
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  ITheme,
  IUnicodeHandling,
  IUnicodeVersionProvider,
} from '@xterm/xterm';
import {
  BufferCell,
  BufferNamespace,
  type PackedBufferRow,
  type PackedBufferSnapshot,
} from './buffer';
import { EventEmitter } from './events';
import { ParserApi } from './parser';
import './style.css';

export type * from '@xterm/xterm';

/** Gespenst runtime and renderer controls layered on top of xterm.js constructor options. */
export interface GespenstXtermRuntimeOptions {
  /** Core execution policy. Dedicated workers remain the default when supported. */
  readonly worker?: false | 'dedicated' | 'shared';
  /** Preferred native renderer and its built-in fallback ladder. */
  readonly renderer?: RendererPreference;
  /** Precompiled module, URL, or bytes for the Ghostty VT runtime. */
  readonly wasm?: NativeTerminalOptions['wasm'];
  /** Precompiled module, URL, or bytes for the Ghostty callback bridge. */
  readonly callbacksWasm?: NativeTerminalOptions['callbacksWasm'];
}

/** Full constructor shape accepted by {@link Terminal}. */
export interface GespenstTerminalOptions extends ITerminalOptions, ITerminalInitOnlyOptions {
  /** Optional native tuning that intentionally lives outside the upstream xterm option surface. */
  readonly gespenst?: GespenstXtermRuntimeOptions;
}

/** Compiled runtime modules reusable by any number of xterm-compatible terminals. */
export interface PreloadedXtermRuntime {
  /** Compiled Ghostty VT module accepted by `gespenst.wasm`. */
  readonly wasm: WebAssembly.Module;
  /** Compiled callback bridge module accepted by `gespenst.callbacksWasm`. */
  readonly callbacksWasm: WebAssembly.Module;
}

/** Compiles and caches both WASM artifacts before a terminal is constructed. */
export async function preloadXtermRuntime(
  options: Pick<GespenstXtermRuntimeOptions, 'wasm' | 'callbacksWasm'> = {}
): Promise<PreloadedXtermRuntime> {
  const [wasm, callbacksWasm] = await Promise.all([
    preloadGhostty(options.wasm ?? DEFAULT_WASM_URL),
    preloadGhostty(options.callbacksWasm ?? DEFAULT_CALLBACKS_URL),
  ]);
  return { wasm, callbacksWasm };
}

/** xterm.js API version targeted by this compatibility package. */
export const XTERM_COMPAT_VERSION = '6.0.0' as const;

const CORE_XTERM_BRIDGE = Symbol.for('@gespenst/core/xterm-compatibility');
const XTERM_BENCHMARK_HOOKS = Symbol.for('@gespenst/xterm/benchmark');
const WRITE_QUEUE_WATERMARK = 50 * 1024 * 1024;
const WRITE_BATCH_BYTES = 1024 * 1024;
const WRITE_SLICE_MS = 8;

interface CoreCompatibilityRow extends PackedBufferRow {}

interface CoreCompatibilityUpdate {
  readonly state: TerminalBufferState;
  readonly dirty: 'clean' | 'partial' | 'full';
  readonly trimmed: number;
  readonly appendStart: number;
  readonly reset: boolean;
  readonly rows: readonly CoreCompatibilityRow[];
}

interface CoreCompatibilityBatch {
  readonly updates: readonly CoreCompatibilityUpdate[];
}

interface CoreCompatibilityBridge {
  onInput?(listener: (data: string | Uint8Array, source: string) => void): {
    readonly dispose: () => void;
  };
  writeAsync(
    data: Uint8Array,
    owned: boolean,
    boundaries: Uint32Array
  ): Promise<CoreCompatibilityBatch>;
  writeMeasured?(
    data: Uint8Array,
    owned: boolean,
    boundaries: Uint32Array
  ): Promise<{
    readonly batch: CoreCompatibilityBatch;
    readonly timing: CoreBenchmarkTiming;
  }>;
}

interface CoreBenchmarkTiming {
  readonly parseMs: number;
  readonly renderWaitMs: number;
  readonly renderMs: number;
  readonly compatibilityMs: number;
  readonly backendMs: number;
}

interface XtermBenchmarkTiming {
  readonly queueMs: number;
  readonly adapterMs: number;
  readonly bufferSyncMs: number;
  readonly callbackMs: number;
  readonly totalMs: number;
  readonly core?: CoreBenchmarkTiming;
}

interface XtermBenchmarkMeasurement {
  readonly queuedAt: number;
  resolve(value: XtermBenchmarkTiming): void;
  reject(error: Error): void;
}

function coreCompatibilityBridge(native: GespenstTerminal): CoreCompatibilityBridge | undefined {
  return (native as unknown as Record<symbol, CoreCompatibilityBridge | undefined>)[
    CORE_XTERM_BRIDGE
  ];
}

/** Error thrown when an xterm.js extension point cannot be implemented over Ghostty. */
export class XtermCompatibilityError extends Error {
  /** Name of the unsupported or disabled xterm.js feature. */
  readonly feature: string;

  /** Creates a compatibility error for an xterm.js feature. */
  constructor(feature: string, message?: string) {
    super(message ?? `${feature} is not supported by @gespenst/xterm`);
    this.name = 'XtermCompatibilityError';
    this.feature = feature;
  }
}

/** Keyboard payload emitted by {@link Terminal.onKey}. */
export interface XtermKeyEvent {
  /** Encoded terminal input generated by the key event. */
  readonly key: string;
  /** Original browser keyboard event. */
  readonly domEvent: KeyboardEvent;
}

/** Inclusive viewport row range emitted by {@link Terminal.onRender}. */
export interface XtermRenderEvent {
  /** First zero-based row requiring a render. */
  readonly start: number;
  /** Last zero-based row requiring a render. */
  readonly end: number;
}

/** Character geometry emitted by {@link Terminal.onResize}. */
export interface XtermResizeEvent {
  /** New number of columns. */
  readonly cols: number;
  /** New number of rows. */
  readonly rows: number;
}

const DEFAULT_OPTIONS: Readonly<ITerminalOptions> = {
  allowProposedApi: false,
  allowTransparency: false,
  altClickMovesCursor: true,
  convertEol: false,
  cursorBlink: false,
  cursorInactiveStyle: 'outline',
  cursorStyle: 'block',
  cursorWidth: 1,
  customGlyphs: true,
  disableStdin: false,
  documentOverride: null,
  drawBoldTextInBrightColors: true,
  fastScrollSensitivity: 5,
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  ignoreBracketedPasteMode: false,
  letterSpacing: 0,
  lineHeight: 1,
  linkHandler: null,
  logLevel: 'info',
  logger: null,
  macOptionClickForcesSelection: false,
  macOptionIsMeta: false,
  minimumContrastRatio: 1,
  overviewRuler: {},
  reflowCursorLine: false,
  rescaleOverlappingGlyphs: false,
  rightClickSelectsWord: isMacPlatform(),
  screenReaderMode: false,
  scrollback: 1000,
  scrollOnEraseInDisplay: false,
  scrollOnUserInput: true,
  scrollSensitivity: 1,
  smoothScrollDuration: 0,
  tabStopWidth: 8,
  theme: {},
  windowsPty: {},
  windowOptions: {},
  wordSeparator: ' ()[]{}\',"`',
};

const INITIAL_MODES: IModes = {
  applicationCursorKeysMode: false,
  applicationKeypadMode: false,
  bracketedPasteMode: false,
  insertMode: false,
  mouseTrackingMode: 'none',
  originMode: false,
  reverseWraparoundMode: false,
  sendFocusMode: false,
  synchronizedOutputMode: false,
  wraparoundMode: true,
};

interface MutableModes {
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  bracketedPasteMode: boolean;
  insertMode: boolean;
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  originMode: boolean;
  reverseWraparoundMode: boolean;
  sendFocusMode: boolean;
  synchronizedOutputMode: boolean;
  wraparoundMode: boolean;
}

class UnicodeHandling implements IUnicodeHandling {
  private active = 'ghostty';
  private readonly proposed: () => void;

  constructor(proposed: () => void) {
    this.proposed = proposed;
  }

  register(_provider: IUnicodeVersionProvider): void {
    this.proposed();
    throw new XtermCompatibilityError(
      'unicode.register',
      'Ghostty owns Unicode width calculation; custom xterm.js Unicode providers cannot replace it'
    );
  }

  get versions(): ReadonlyArray<string> {
    this.proposed();
    return ['ghostty'];
  }

  get activeVersion(): string {
    this.proposed();
    return this.active;
  }

  set activeVersion(value: string) {
    this.proposed();
    if (value !== 'ghostty') throw new XtermCompatibilityError('unicode.activeVersion');
    this.active = value;
  }
}

let nextMarkerId = 1;

class Marker implements IMarker {
  readonly id = nextMarkerId++;
  private disposed = false;
  private lineValue: number;
  private readonly cleanup: (marker: Marker) => void;
  private readonly disposeEvent = new EventEmitter<void>();
  readonly onDispose = this.disposeEvent.event;

  constructor(line: number, cleanup: (marker: Marker) => void) {
    this.lineValue = line;
    this.cleanup = cleanup;
  }

  get line(): number {
    return this.disposed ? -1 : this.lineValue;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  trim(amount: number): void {
    if (this.disposed || amount <= 0) return;
    this.lineValue -= amount;
    if (this.lineValue < 0) this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lineValue = -1;
    this.cleanup(this);
    this.disposeEvent.fire(undefined);
    this.disposeEvent.dispose();
  }
}

class Decoration implements IDecoration {
  readonly marker: IMarker;
  element: HTMLElement | undefined;
  options: Pick<IDecorationOptions, 'overviewRulerOptions'>;
  private disposed = false;
  private readonly disposeEvent = new EventEmitter<void>();
  private readonly renderEvent = new EventEmitter<HTMLElement>();
  private readonly source: IDecorationOptions;
  private readonly markerSubscription: IDisposable;
  private readonly layout: () => {
    readonly cellWidthPx: number;
    readonly cellHeightPx: number;
    readonly viewportY: number;
    readonly cols: number;
    readonly rows: number;
    readonly activeBuffer: 'normal' | 'alternate';
  };
  readonly onDispose = this.disposeEvent.event;
  readonly onRender = this.renderEvent.event;

  constructor(
    marker: IMarker,
    source: IDecorationOptions,
    host: HTMLElement,
    layout: () => {
      readonly cellWidthPx: number;
      readonly cellHeightPx: number;
      readonly viewportY: number;
      readonly cols: number;
      readonly rows: number;
      readonly activeBuffer: 'normal' | 'alternate';
    }
  ) {
    this.marker = marker;
    this.source = source;
    this.layout = layout;
    this.options = source.overviewRulerOptions
      ? { overviewRulerOptions: source.overviewRulerOptions }
      : {};
    const element = host.ownerDocument.createElement('div');
    element.className = 'xterm-decoration';
    element.style.position = 'absolute';
    element.style.pointerEvents = 'none';
    element.style.zIndex = source.layer === 'top' ? '4' : '1';
    if (source.backgroundColor) element.style.backgroundColor = source.backgroundColor;
    if (source.foregroundColor) element.style.color = source.foregroundColor;
    host.append(element);
    this.element = element;
    this.markerSubscription = marker.onDispose(() => this.dispose());
    this.refresh();
    queueMicrotask(() => {
      if (!this.disposed && this.element) this.renderEvent.fire(this.element);
    });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  refresh(): void {
    const element = this.element;
    if (this.disposed || !element) return;
    const layout = this.layout();
    const row = this.marker.line - layout.viewportY;
    const x = this.source.x ?? 0;
    const visible =
      layout.activeBuffer === 'normal' &&
      !this.marker.isDisposed &&
      row >= 0 &&
      row < layout.rows &&
      x < layout.cols;
    element.style.display = visible ? '' : 'none';
    element.style.width = `${(this.source.width ?? 1) * layout.cellWidthPx}px`;
    element.style.height = `${(this.source.height ?? 1) * layout.cellHeightPx}px`;
    element.style.lineHeight = `${layout.cellHeightPx}px`;
    element.style.top = `${row * layout.cellHeightPx}px`;
    if (this.source.anchor === 'right') {
      element.style.left = '';
      element.style.right = `${x * layout.cellWidthPx}px`;
    } else {
      element.style.right = '';
      element.style.left = `${x * layout.cellWidthPx}px`;
    }
    this.renderEvent.fire(element);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.markerSubscription.dispose();
    this.element?.remove();
    this.element = undefined;
    this.disposeEvent.fire(undefined);
    this.disposeEvent.dispose();
    this.renderEvent.dispose();
  }
}

/**
 * The stable xterm.js 6 public API backed by Ghostty's VT implementation.
 * Use `ready` whenever work must wait for the asynchronous WASM startup.
 */
export class Terminal {
  /** Localizable strings used by accessibility helpers. */
  static strings: ILocalizableStrings = {
    promptLabel: 'Terminal input',
    tooMuchOutput: 'Too much output to announce, navigate to rows manually to read',
  };

  /** Resolves to the underlying native Gespenst terminal. */
  readonly native: Promise<GespenstTerminal>;
  /** Resolves after the Ghostty WASM runtime is initialized and native listeners are installed. */
  readonly ready: Promise<void>;
  /** xterm-compatible normal, alternate, and active buffer views. */
  readonly buffer: IBufferNamespace;
  /** xterm-compatible parser registration API applied before bytes reach Ghostty. */
  readonly parser: IParser;
  /** Unicode-width provider namespace; Ghostty remains the authoritative width engine. */
  readonly unicode: IUnicodeHandling;

  private elementValue: HTMLElement | undefined;
  private textareaValue: HTMLTextAreaElement | undefined;
  private viewportValue: HTMLDivElement | undefined;
  private scrollAreaValue: HTMLDivElement | undefined;
  private syncingScrollbar = false;
  private nativeValue: GespenstTerminal | undefined;
  private rowsValue: number;
  private colsValue: number;
  private optionValues: ITerminalOptions;
  private readonly gespenstOptions: GespenstXtermRuntimeOptions;
  private readonly optionsProxy: ITerminalOptions;
  private modeValues: MutableModes = { ...INITIAL_MODES };
  private selectionValue = '';
  private selectionPosition: IBufferRange | undefined;
  private disposed = false;
  private opened = false;
  private writeQueue = Promise.resolve();
  private readonly pendingWrites: Array<
    | {
        readonly kind: 'write';
        readonly data: string | Uint8Array;
        readonly callback?: () => void;
        readonly measurement?: XtermBenchmarkMeasurement;
      }
    | { readonly kind: 'clear' }
  > = [];
  private pendingWriteHead = 0;
  private writeFlushScheduled = false;
  private pendingWriteBytes = 0;
  private didUserInput = false;
  private compatibilityWritesPending = 0;
  private mountingNative = false;
  private writeParsedQueued = false;
  private pendingRenderRange: XtermRenderEvent | null = null;
  private lastCursor = '0:0';
  private lastKeyboardEvent: KeyboardEvent | undefined;
  private customKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  private customWheelHandler: ((event: WheelEvent) => boolean) | undefined;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private convertEolPreviousWasCarriageReturn = false;
  private viewportSyncPromise: Promise<void> | null = null;
  private readonly bufferValue: BufferNamespace;
  private readonly parserValue = new ParserApi();
  private readonly markersValue: Marker[] = [];
  private readonly decorations = new Set<Decoration>();
  private readonly addons: ITerminalAddon[] = [];
  private readonly disposables: IDisposable[] = [];
  private readonly linkProviders = new Set<ILinkProvider>();
  private activeLink: ILink | null = null;
  private pointerDownLink: ILink | null = null;
  private lastLinkEvent: MouseEvent | null = null;
  private linkRequest = 0;
  private readonly linkDecorations: HTMLElement[] = [];
  private resolveNative!: (terminal: GespenstTerminal) => void;
  private rejectNative!: (error: unknown) => void;
  private nativeStarted = false;
  private cursorAttributes: TerminalCursorAttributes | undefined;
  /** @internal Narrow private shim required by the version-pinned fit and serialize addons. */
  readonly _core: {
    readonly _renderService: {
      readonly dimensions: {
        readonly css: { readonly cell: { readonly width: number; readonly height: number } };
      };
      clear(): void;
    };
    readonly _inputHandler: { _curAttrData: BufferCell };
    readonly _themeService: { readonly colors: { ansi: XtermInternalColor[] } };
  };

  private readonly bellEvent = new EventEmitter<void>();
  private readonly binaryEvent = new EventEmitter<string>();
  private readonly cursorMoveEvent = new EventEmitter<void>();
  private readonly dataEvent = new EventEmitter<string>();
  private readonly keyEvent = new EventEmitter<XtermKeyEvent>();
  private readonly lineFeedEvent = new EventEmitter<void>();
  private readonly renderEvent = new EventEmitter<XtermRenderEvent>();
  private readonly writeParsedEvent = new EventEmitter<void>();
  private readonly resizeEvent = new EventEmitter<XtermResizeEvent>();
  private readonly scrollEvent = new EventEmitter<number>();
  private readonly selectionEvent = new EventEmitter<void>();
  private readonly titleEvent = new EventEmitter<string>();

  /** Fires when the terminal processes a bell control character. */
  readonly onBell = this.bellEvent.event;
  /** Fires for binary input emitted by the compatibility layer. */
  readonly onBinary = this.binaryEvent.event;
  /** Fires when the active buffer cursor moves. */
  readonly onCursorMove = this.cursorMoveEvent.event;
  /** Fires when user input should be forwarded to the PTY. */
  readonly onData = this.dataEvent.event;
  /** Fires with both encoded input and the originating browser key event. */
  readonly onKey = this.keyEvent.event;
  /** Fires when parsed output advances to a new line. */
  readonly onLineFeed = this.lineFeedEvent.event;
  /** Fires when an inclusive viewport row range needs rendering. */
  readonly onRender = this.renderEvent.event;
  /** Fires after a queued write has been parsed and synchronized. */
  readonly onWriteParsed = this.writeParsedEvent.event;
  /** Fires when terminal character geometry changes. */
  readonly onResize = this.resizeEvent.event;
  /** Fires with the current viewport scroll position. */
  readonly onScroll = this.scrollEvent.event;
  /** Fires when the current text selection changes. */
  readonly onSelectionChange = this.selectionEvent.event;
  /** Fires when a VT title sequence changes the terminal title. */
  readonly onTitleChange = this.titleEvent.event;

  /** Creates a terminal using xterm.js initialization and runtime options. */
  constructor(options: GespenstTerminalOptions = {}) {
    this.colsValue = normalizeDimension(options.cols, 80, 2);
    this.rowsValue = normalizeDimension(options.rows, 24, 1);
    const { cols: _cols, rows: _rows, gespenst = {}, ...runtimeOptions } = options;
    this.gespenstOptions = gespenst;
    this.optionValues = { ...DEFAULT_OPTIONS };
    this.optionValues = applyValidatedOptions(this.optionValues, runtimeOptions, true);
    assertSupportedOptions(this.optionValues);
    this.optionsProxy = createOptionsProxy(
      () => this.optionValues,
      (property, value) => this.applyOptions({ [property]: value } as ITerminalOptions)
    );
    this.bufferValue = new BufferNamespace(
      this.colsValue,
      this.rowsValue,
      this.optionValues.scrollback ?? 1000
    );
    this.buffer = this.bufferValue;
    this.parser = this.parserValue;
    this.unicode = new UnicodeHandling(() => this.requireProposed('unicode'));
    const emptyCursor = new BufferCell();
    const terminal = this;
    this._core = {
      _renderService: {
        get dimensions() {
          const metrics = terminal.cssCellMetrics();
          return { css: { cell: { width: metrics.cellWidthPx, height: metrics.cellHeightPx } } };
        },
        clear: () => this.clearTextureAtlas(),
      },
      _inputHandler: { _curAttrData: emptyCursor },
      _themeService: { colors: { ansi: xtermAnsiColors(this.optionValues.theme) } },
    };
    this.native = new Promise<GespenstTerminal>((resolve, reject) => {
      this.resolveNative = resolve;
      this.rejectNative = reject;
    });
    this.ready = this.native.then((native) => {
      if (this.disposed) {
        native.dispose();
        return undefined;
      }
      this.nativeValue = native;
      this.bindNative(native);
      return undefined;
    });
    Object.defineProperty(this, XTERM_BENCHMARK_HOOKS, {
      configurable: false,
      enumerable: false,
      value: {
        write: (data: string | Uint8Array) => this.writeMeasured(data),
      },
      writable: false,
    });
  }

  /** The root xterm-compatible element after {@link open} has been called. */
  get element(): HTMLElement | undefined {
    return this.elementValue;
  }

  /** The native terminal's input textarea after asynchronous startup. */
  get textarea(): HTMLTextAreaElement | undefined {
    return this.textareaValue;
  }

  /** Current number of terminal rows. */
  get rows(): number {
    return this.rowsValue;
  }

  /** Current number of terminal columns. */
  get cols(): number {
    return this.colsValue;
  }

  /** Registered markers in the normal buffer. Requires the proposed API option. */
  get markers(): ReadonlyArray<IMarker> {
    this.requireProposed('markers');
    return this.buffer.active.type === 'alternate' ? [] : this.markersValue;
  }

  /** Current terminal mode flags mirrored from parsed VT control sequences. */
  get modes(): IModes {
    return this.modeValues;
  }

  /** Mutable xterm.js runtime options proxy. */
  get options(): ITerminalOptions {
    return this.optionsProxy;
  }

  /** Applies one or more xterm.js runtime options. */
  set options(value: ITerminalOptions) {
    this.applyOptions(value);
  }

  /** Removes keyboard focus from the terminal input element. */
  blur(): void {
    this.queueNative((native) => native.blur());
  }

  /** Moves keyboard focus to the terminal input element. */
  focus(): void {
    this.queueNative((native) => native.focus());
  }

  /** Sends user input to the PTY-facing native input stream. */
  input(data: string, wasUserInput = true): void {
    if (this.optionValues.disableStdin) return;
    if (wasUserInput) this.didUserInput = true;
    if (wasUserInput) this.clearSelection();
    if (wasUserInput && this.optionValues.scrollOnUserInput) this.scrollToBottom();
    this.dataEvent.fire(data);
  }

  /** Resizes the terminal to the requested character geometry. */
  resize(columns: number, rows: number): void {
    this.assertActive();
    verifyIntegers(columns, rows);
    this.colsValue = normalizeDimension(columns, this.colsValue, 2);
    this.rowsValue = normalizeDimension(rows, this.rowsValue, 1);
    this.bufferValue.resize(this.colsValue, this.rowsValue);
    const nextCols = this.colsValue;
    const nextRows = this.rowsValue;
    this.queueNative((native) => native.resize(nextCols, nextRows));
  }

  /** Mounts the terminal in `parent`; repeated calls after a successful open are no-ops. */
  open(parent: HTMLElement): void {
    this.assertActive();
    if (!parent) throw new Error('Terminal requires a parent element.');
    if (this.opened) return;
    this.opened = true;
    const ownerDocument = validDocument(this.optionValues.documentOverride) ?? parent.ownerDocument;
    const element = ownerDocument.createElement('div');
    element.dir = 'ltr';
    element.className = 'terminal xterm';
    const viewport = ownerDocument.createElement('div');
    viewport.className = 'xterm-viewport';
    viewport.setAttribute('aria-hidden', 'true');
    const scrollArea = ownerDocument.createElement('div');
    scrollArea.className = 'xterm-scroll-area';
    viewport.append(scrollArea);
    const screen = ownerDocument.createElement('div');
    screen.className = 'xterm-screen';
    element.append(viewport, screen);
    parent.append(element);
    this.elementValue = element;
    this.viewportValue = viewport;
    this.scrollAreaValue = scrollArea;
    this.updateScrollbarGutter();
    this.bindDom(element);
    this.startNative();
    void this.native
      .then(async (native) => {
        if (this.disposed) return;
        const cols = this.colsValue;
        const rows = this.rowsValue;
        this.mountingNative = true;
        try {
          await native.open(screen);
          // Core `open()` fits its host by design, while xterm.js preserves the configured grid
          // until the caller or FitAddon explicitly resizes it.
          native.resize(cols, rows);
        } finally {
          this.mountingNative = false;
        }
        this.textareaValue = native.element.querySelector('textarea') ?? undefined;
        this.textareaValue?.classList.add('xterm-helper-textarea');
        if (this.textareaValue)
          this.textareaValue.readOnly = this.optionValues.disableStdin ?? false;
        this.applyTextareaStrings();
        await this.syncViewport();
      })
      .catch((error: unknown) => {
        if (!this.disposed) this.logError(error);
      });
  }

  /** Installs a keyboard event filter invoked before the native input handler. */
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyHandler = handler;
  }

  /** Installs a wheel event filter invoked before native scrolling. */
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void {
    this.customWheelHandler = handler;
  }

  /** Registers an xterm.js link provider and returns a disposable registration. */
  registerLinkProvider(linkProvider: ILinkProvider): IDisposable {
    this.linkProviders.add(linkProvider);
    return {
      dispose: () => {
        this.linkProviders.delete(linkProvider);
        this.clearActiveLink();
      },
    };
  }

  /**
   * Character joiners cannot replace Ghostty's internal shaping and throw when invoked.
   * @throws {@link XtermCompatibilityError}
   */
  registerCharacterJoiner(_handler: (text: string) => [number, number][]): number {
    this.requireProposed('registerCharacterJoiner');
    throw new XtermCompatibilityError(
      'registerCharacterJoiner',
      'Ghostty performs grapheme shaping internally and does not expose a character joiner hook'
    );
  }

  /**
   * Character joiners are unsupported and this operation throws when invoked.
   * @throws {@link XtermCompatibilityError}
   */
  deregisterCharacterJoiner(_joinerId: number): void {
    this.requireProposed('deregisterCharacterJoiner');
    throw new XtermCompatibilityError('deregisterCharacterJoiner');
  }

  /** Registers a marker relative to the current cursor row. */
  registerMarker(cursorYOffset = 0): IMarker {
    verifyIntegers(cursorYOffset);
    const marker = new Marker(
      Math.max(0, this.buffer.active.baseY + this.buffer.active.cursorY + cursorYOffset),
      (value) => {
        const index = this.markersValue.indexOf(value);
        if (index !== -1) this.markersValue.splice(index, 1);
      }
    );
    this.markersValue.push(marker);
    return marker;
  }

  /** Registers a DOM decoration for a marker. Requires the proposed API option. */
  registerDecoration(options: IDecorationOptions): IDecoration | undefined {
    this.requireProposed('registerDecoration');
    verifyPositiveIntegers(options.x ?? 0, options.width ?? 0, options.height ?? 0);
    if (options.marker.isDisposed || this.buffer.active.type === 'alternate' || !this.elementValue)
      return undefined;
    const decoration = new Decoration(options.marker, options, this.elementValue, () => ({
      ...this.cssCellMetrics(),
      viewportY: this.buffer.active.viewportY,
      cols: this.colsValue,
      rows: this.rowsValue,
      activeBuffer: this.buffer.active.type,
    }));
    this.decorations.add(decoration);
    decoration.onDispose(() => this.decorations.delete(decoration));
    return decoration;
  }

  /** Returns whether the terminal currently has a non-empty selection. */
  hasSelection(): boolean {
    return this.selectionValue.length > 0;
  }

  /** Returns the selected text. */
  getSelection(): string {
    return this.selectionValue;
  }

  /** Returns the selected xterm buffer range, when a selection exists. */
  getSelectionPosition(): IBufferRange | undefined {
    return this.selectionPosition;
  }

  /** Clears the current selection. */
  clearSelection(): void {
    this.selectionValue = '';
    this.selectionPosition = undefined;
    this.queueNative((native) => native.clearSelection());
  }

  /** Selects `length` characters from a zero-based buffer coordinate. */
  select(column: number, row: number, length: number): void {
    verifyIntegers(column, row, length);
    if (!this.nativeValue || length <= 0) return;
    const end = column + length;
    const endRow = row + Math.floor(end / this.colsValue);
    const endColumn = end % this.colsValue;
    this.selectionPosition = {
      start: { x: column, y: row },
      end: { x: endColumn, y: endRow },
    };
    this.pointerSelection(column, row, endColumn, endRow);
  }

  /** Selects all available buffer content. */
  selectAll(): void {
    this.selectionPosition = {
      start: { x: 0, y: 0 },
      end: { x: this.colsValue, y: Math.max(0, this.buffer.active.length - 1) },
    };
    this.queueNative((native) => {
      native.selectAll();
      this.refreshSelection();
    });
  }

  /** Selects a contiguous range of zero-based buffer rows. */
  selectLines(start: number, end: number): void {
    verifyIntegers(start, end);
    const first = Math.min(start, end);
    const last = Math.max(start, end);
    this.select(0, first, (last - first + 1) * this.colsValue);
  }

  /** Disposes addons, events, markers, decorations, DOM, and the native terminal. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const addon of this.addons.splice(0).reverse()) addon.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    for (const marker of [...this.markersValue]) marker.dispose();
    for (const decoration of this.decorations) decoration.dispose();
    this.clearActiveLink();
    this.bufferValue.dispose();
    this.nativeValue?.dispose();
    this.elementValue?.remove();
    this.elementValue = undefined;
    this.textareaValue = undefined;
    this.viewportValue = undefined;
    this.scrollAreaValue = undefined;
    this.disposeEvents();
  }

  /** Scrolls the viewport by a signed row count. */
  scrollLines(amount: number): void {
    verifyIntegers(amount);
    this.queueNative((native) => native.scrollLines(amount));
  }

  /** Scrolls the viewport by a signed page count. */
  scrollPages(pageCount: number): void {
    verifyIntegers(pageCount);
    this.scrollLines(pageCount * Math.max(1, this.rowsValue - 1));
  }

  /** Scrolls to the beginning of the buffer. */
  scrollToTop(): void {
    this.queueNative((native) => native.scrollToTop());
  }

  /** Scrolls to the end of the buffer. */
  scrollToBottom(): void {
    this.queueNative((native) => native.scrollToBottom());
  }

  /** Scrolls to an absolute zero-based buffer row. */
  scrollToLine(line: number): void {
    verifyIntegers(line);
    this.queueNative((native) => {
      native.scrollToTop();
      native.scrollLines(Math.max(0, line));
    });
  }

  /** Clears scrollback and moves the current cursor row to the top, matching xterm.js. */
  clear(): void {
    this.assertActive();
    this.startNative();
    this.pendingWrites.push({ kind: 'clear' });
    this.scheduleWriteFlush();
  }

  /** Queues text or bytes for Ghostty parsing and invokes `callback` after synchronization. */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.assertActive();
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (this.pendingWriteBytes + size > WRITE_QUEUE_WATERMARK) {
      throw new Error('write data discarded, use flow control to avoid losing data');
    }
    this.startNative();
    this.pendingWrites.push({ kind: 'write', data, ...(callback ? { callback } : {}) });
    this.pendingWriteBytes += size;
    this.scheduleWriteFlush();
  }

  private writeMeasured(data: string | Uint8Array): Promise<XtermBenchmarkTiming> {
    this.assertActive();
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (this.pendingWriteBytes + size > WRITE_QUEUE_WATERMARK) {
      return Promise.reject(
        new Error('write data discarded, use flow control to avoid losing data')
      );
    }
    this.startNative();
    const measured = new Promise<XtermBenchmarkTiming>((resolve, reject) => {
      this.pendingWrites.push({
        kind: 'write',
        data,
        measurement: { queuedAt: performance.now(), resolve, reject },
      });
    });
    this.pendingWriteBytes += size;
    this.scheduleWriteFlush();
    return measured;
  }

  private scheduleWriteFlush(): void {
    if (this.writeFlushScheduled) return;
    this.writeFlushScheduled = true;
    const flush = () => {
      this.writeFlushScheduled = false;
      this.writeQueue = this.writeQueue
        .then(() => this.flushWrites())
        .catch((error: unknown) => this.logError(error))
        .finally(() => {
          if (!this.disposed && this.pendingWriteHead < this.pendingWrites.length)
            this.scheduleWriteFlush();
        });
    };
    if (this.didUserInput) {
      this.didUserInput = false;
      queueMicrotask(flush);
    } else setTimeout(flush, 0);
  }

  /** Writes text or bytes followed by carriage return and line feed. */
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === 'string') this.write(`${data}\r\n`, callback);
    else {
      const value = new Uint8Array(data.length + 2);
      value.set(data);
      value.set([13, 10], data.length);
      this.write(value, callback);
    }
  }

  /** Sends pasted text through Ghostty's paste input path. */
  paste(data: string): void {
    if (this.optionValues.disableStdin) return;
    const value = data.replace(/\r?\n/gu, '\r');
    this.clearSelection();
    if (this.optionValues.scrollOnUserInput) this.scrollToBottom();
    this.dataEvent.fire(
      this.modeValues.bracketedPasteMode && !this.optionValues.ignoreBracketedPasteMode
        ? `\x1b[200~${value}\x1b[201~`
        : value
    );
  }

  /** Emits an xterm-compatible render event for the inclusive row range. */
  refresh(start: number, end: number): void {
    verifyIntegers(start, end);
    this.renderEvent.fire({
      start: Math.max(0, Math.min(this.rowsValue - 1, Math.trunc(start))),
      end: Math.max(0, Math.min(this.rowsValue - 1, Math.trunc(end))),
    });
  }

  /** Invalidates the full visible render range. */
  clearTextureAtlas(): void {
    this.refresh(0, this.rowsValue - 1);
  }

  /** Resets VT state, sidecar modes, and buffer tracking. */
  reset(): void {
    this.modeValues = { ...INITIAL_MODES };
    this.convertEolPreviousWasCarriageReturn = false;
    this.bufferValue.setAlternate(false);
    for (const marker of [...this.markersValue]) marker.dispose();
    this.queueNative((native) => {
      native.reset();
      this.queueViewportSync();
    });
  }

  /** Activates an xterm.js addon and owns it until terminal disposal. */
  loadAddon(addon: ITerminalAddon): void {
    this.assertActive();
    const originalDispose = addon.dispose.bind(addon);
    let active = true;
    addon.dispose = () => {
      if (!active) return;
      active = false;
      const index = this.addons.indexOf(addon);
      if (index !== -1) this.addons.splice(index, 1);
      originalDispose();
    };
    this.addons.push(addon);
    try {
      addon.activate(this);
    } catch (error) {
      addon.dispose();
      throw error;
    }
  }

  private nativeOptions(): NativeTerminalOptions {
    const theme = convertTheme(this.optionValues.theme);
    return {
      cols: this.colsValue,
      rows: this.rowsValue,
      ...(validDocument(this.optionValues.documentOverride)
        ? { documentOverride: this.optionValues.documentOverride as Document }
        : {}),
      ...(this.optionValues.scrollback === undefined
        ? {}
        : { scrollbackLines: this.optionValues.scrollback }),
      ...(this.optionValues.fontFamily === undefined
        ? {}
        : { fontFamily: this.optionValues.fontFamily }),
      ...(this.optionValues.fontSize === undefined
        ? {}
        : { fontSizePx: this.optionValues.fontSize }),
      ...(this.optionValues.lineHeight === undefined
        ? {}
        : { lineHeight: this.optionValues.lineHeight }),
      ...(this.optionValues.fontWeight === undefined
        ? {}
        : { fontWeight: this.optionValues.fontWeight }),
      ...(this.optionValues.fontWeightBold === undefined
        ? {}
        : { fontWeightBold: this.optionValues.fontWeightBold }),
      ...(this.optionValues.letterSpacing === undefined
        ? {}
        : { letterSpacingPx: this.optionValues.letterSpacing }),
      accessibility: this.optionValues.screenReaderMode ? 'full' : 'basic',
      allowTransparency: this.optionValues.allowTransparency ?? false,
      minimumContrastRatio: this.optionValues.minimumContrastRatio ?? 1,
      defaultCursorStyle: this.optionValues.cursorStyle ?? 'block',
      defaultCursorBlink: this.optionValues.cursorBlink ?? false,
      ...(this.gespenstOptions.worker === undefined ? {} : { worker: this.gespenstOptions.worker }),
      ...(this.gespenstOptions.renderer === undefined
        ? {}
        : { renderer: this.gespenstOptions.renderer }),
      ...(this.gespenstOptions.wasm === undefined ? {} : { wasm: this.gespenstOptions.wasm }),
      ...(this.gespenstOptions.callbacksWasm === undefined
        ? {}
        : { callbacksWasm: this.gespenstOptions.callbacksWasm }),
      ...(theme ? { theme } : {}),
    };
  }

  private async flushWrites(): Promise<void> {
    const entries: typeof this.pendingWrites = [];
    let batchBytes = 0;
    while (this.pendingWriteHead < this.pendingWrites.length) {
      const entry = this.pendingWrites[this.pendingWriteHead];
      if (!entry) break;
      const size =
        entry.kind === 'write'
          ? typeof entry.data === 'string'
            ? entry.data.length
            : entry.data.byteLength
          : 0;
      if (entries.length > 0 && batchBytes + size > WRITE_BATCH_BYTES) break;
      this.pendingWriteHead += 1;
      entries.push(entry);
      batchBytes += size;
      this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - size);
      if (batchBytes >= WRITE_BATCH_BYTES) break;
    }
    if (
      this.pendingWriteHead === this.pendingWrites.length ||
      (this.pendingWriteHead > 1024 && this.pendingWriteHead * 2 > this.pendingWrites.length)
    ) {
      this.pendingWrites.splice(0, this.pendingWriteHead);
      this.pendingWriteHead = 0;
    }
    if (entries.length === 0 || this.disposed) return;
    const native = await this.native;
    if (this.disposed) return;
    const bridge = coreCompatibilityBridge(native);
    const chunks: Array<{ readonly data: Uint8Array; readonly owned: boolean }> = [];
    let sliceStarted = performance.now();
    const flushChunks = async (): Promise<void> => {
      if (chunks.length === 0) return;
      let output: Uint8Array;
      let owned: boolean;
      if (chunks.length === 1) {
        const chunk = chunks.shift();
        if (!chunk) return;
        output = chunk.data;
        owned = chunk.owned;
      } else {
        const length = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
        output = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks.splice(0)) {
          output.set(chunk.data, offset);
          offset += chunk.data.byteLength;
        }
        owned = true;
      }
      if (bridge) {
        this.compatibilityWritesPending += 1;
        try {
          const batch = await bridge.writeAsync(
            output,
            owned,
            this.compatibilityBoundaries(output)
          );
          await this.applyCompatibilityBatch(batch);
        } finally {
          this.compatibilityWritesPending -= 1;
        }
      } else {
        await native.writeAsync(output);
        await this.syncViewport();
      }
    };
    for (const entry of entries) {
      if (entry.kind === 'clear') {
        await flushChunks();
        await this.syncViewport();
        const buffer = this.buffer.active;
        const cursorX = buffer.cursorX;
        const cursorY = buffer.cursorY;
        const scroll = cursorY > 0 ? `\x1b[${cursorY}S` : '';
        const clearBelow = this.rowsValue > 1 ? '\x1b[2;1H\x1b[0J' : '';
        await native.writeAsync(`${scroll}${clearBelow}\x1b[1;${cursorX + 1}H\x1b[3J`);
        await this.syncViewport();
        continue;
      }
      if (entry.measurement) {
        await flushChunks();
        const measurement = entry.measurement;
        const adapterStartedAt = performance.now();
        try {
          const normalized = this.normalizeWrite(entry.data);
          const filtered = this.parserValue.active
            ? await this.parserValue.process(normalized)
            : normalized;
          this.emitLineFeeds(filtered);
          const bytes = typeof filtered === 'string' ? this.encoder.encode(filtered) : filtered;
          const adapterMs = performance.now() - adapterStartedAt;
          let core: CoreBenchmarkTiming | undefined;
          let bufferSyncMs = 0;
          if (bytes.byteLength > 0 && bridge?.writeMeasured) {
            this.compatibilityWritesPending += 1;
            try {
              const syncStartedAt = performance.now();
              const result = await bridge.writeMeasured(
                bytes,
                typeof filtered === 'string' || filtered !== entry.data,
                this.compatibilityBoundaries(bytes)
              );
              await this.applyCompatibilityBatch(result.batch);
              core = result.timing;
              bufferSyncMs = performance.now() - syncStartedAt;
            } finally {
              this.compatibilityWritesPending -= 1;
            }
          } else if (bytes.byteLength > 0) {
            if (bridge) {
              const syncStartedAt = performance.now();
              const batch = await bridge.writeAsync(
                bytes,
                typeof filtered === 'string' || filtered !== entry.data,
                this.compatibilityBoundaries(bytes)
              );
              await this.applyCompatibilityBatch(batch);
              bufferSyncMs = performance.now() - syncStartedAt;
            } else {
              await native.writeAsync(bytes);
              const syncStartedAt = performance.now();
              await this.syncViewport();
              bufferSyncMs = performance.now() - syncStartedAt;
            }
          }
          const callbackStartedAt = performance.now();
          const result: {
            queueMs: number;
            adapterMs: number;
            bufferSyncMs: number;
            callbackMs: number;
            totalMs: number;
            core?: CoreBenchmarkTiming;
          } = {
            queueMs: adapterStartedAt - measurement.queuedAt,
            adapterMs,
            bufferSyncMs,
            callbackMs: 0,
            totalMs: callbackStartedAt - measurement.queuedAt,
            ...(core ? { core } : {}),
          };
          measurement.resolve(result);
          result.callbackMs = performance.now() - callbackStartedAt;
        } catch (error) {
          measurement.reject(error instanceof Error ? error : new Error(String(error)));
        }
        continue;
      }
      const normalized = this.normalizeWrite(entry.data);
      const filtered = this.parserValue.active
        ? await this.parserValue.process(normalized)
        : normalized;
      this.emitLineFeeds(filtered);
      const bytes = typeof filtered === 'string' ? this.encoder.encode(filtered) : filtered;
      if (bytes.byteLength > 0)
        chunks.push({
          data: bytes,
          owned: typeof filtered === 'string' || filtered !== entry.data,
        });
      if (
        (this.parserValue.active || this.lineFeedEvent.hasListeners) &&
        performance.now() - sliceStarted >= WRITE_SLICE_MS
      ) {
        await flushChunks();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        sliceStarted = performance.now();
      }
    }
    await flushChunks();
    for (const entry of entries) if (entry.kind === 'write') entry.callback?.();
  }

  private compatibilityBoundaries(data: Uint8Array): Uint32Array {
    if ((this.optionValues.scrollback ?? 1000) === 0 || this.rowsValue <= 1) {
      return new Uint32Array([data.byteLength]);
    }
    const maximumLineFeeds = Math.max(1, this.rowsValue - 1);
    const maximumBytes = Math.max(1, this.colsValue * maximumLineFeeds);
    const boundaries: number[] = [];
    let start = 0;
    let lineFeeds = 0;
    for (let index = 0; index < data.byteLength; index += 1) {
      if (data[index] === 0x0a) lineFeeds += 1;
      if (lineFeeds < maximumLineFeeds && index + 1 - start < maximumBytes) continue;
      boundaries.push(index + 1);
      start = index + 1;
      lineFeeds = 0;
    }
    if (start < data.byteLength || boundaries.length === 0) boundaries.push(data.byteLength);
    return Uint32Array.from(boundaries);
  }

  private startNative(): void {
    if (this.nativeStarted) return;
    this.nativeStarted = true;
    void createTerminal(this.nativeOptions()).then(this.resolveNative, this.rejectNative);
  }

  private bindNative(native: GespenstTerminal): void {
    const bridge = coreCompatibilityBridge(native);
    const input = bridge?.onInput
      ? bridge.onInput((data, source) => this.handleNativeInput(data, source))
      : native.on('input', ({ data, source }) => this.handleNativeInput(data, source));
    this.disposables.push(
      input,
      native.on('bell', () => this.bellEvent.fire(undefined)),
      native.on('title', (title) => this.titleEvent.fire(title)),
      native.on('scroll', (position) => {
        this.scrollEvent.fire(position);
        if (this.compatibilityWritesPending === 0) this.queueViewportSync();
      }),
      native.on('selectionChange', () => this.refreshSelection(true)),
      native.on('viewportChange', () => {
        const range = this.pendingRenderRange;
        this.pendingRenderRange = null;
        if (range && this.renderEvent.hasListeners) this.renderEvent.fire(range);
      }),
      native.on('resize', ({ cols, rows }) => {
        if (this.mountingNative) return;
        this.colsValue = cols;
        this.rowsValue = rows;
        this.resizeEvent.fire({ cols, rows });
        this.queueViewportSync();
      }),
      native.on('font', () => this.queueViewportSync())
    );
  }

  private handleNativeInput(data: string | Uint8Array, source: string): void {
    if (source === 'key' || source === 'text' || source === 'paste') this.didUserInput = true;
    if (
      source === 'mouse' &&
      data instanceof Uint8Array &&
      data.length >= 3 &&
      data[0] === 0x1b &&
      data[1] === 0x5b &&
      data[2] === 0x4d
    ) {
      this.binaryEvent.fire(String.fromCharCode(...data));
      this.lastKeyboardEvent = undefined;
      return;
    }
    const value = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    if (!value) return;
    this.dataEvent.fire(value);
    if (source === 'key' && this.lastKeyboardEvent && this.lastKeyboardEvent.type === 'keydown') {
      this.keyEvent.fire({ key: value, domEvent: this.lastKeyboardEvent });
      this.lastKeyboardEvent = undefined;
    } else if (source !== 'key') this.lastKeyboardEvent = undefined;
  }

  private bindDom(element: HTMLElement): void {
    element.addEventListener(
      'keydown',
      (event) => {
        const accepted =
          !this.optionValues.disableStdin && this.customKeyHandler?.(event) !== false;
        this.lastKeyboardEvent = accepted && !isModifierKey(event) ? event : undefined;
        if (!accepted) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
    this.viewportValue?.addEventListener('scroll', () => {
      if (this.syncingScrollbar) return;
      const metrics = this.cssCellMetrics();
      if (metrics.cellHeightPx <= 0) return;
      this.scrollToLine(Math.round((this.viewportValue?.scrollTop ?? 0) / metrics.cellHeightPx));
    });
    element.addEventListener(
      'keyup',
      (event) => {
        this.lastKeyboardEvent = undefined;
        if (this.optionValues.disableStdin || this.customKeyHandler?.(event) === false) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
    element.addEventListener(
      'wheel',
      (event) => {
        if (this.customWheelHandler?.(event) === false) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true, passive: false }
    );
    element.addEventListener('mousemove', (event) => this.updateLink(event));
    element.addEventListener('mouseleave', (event) => this.clearActiveLink(event));
    element.addEventListener('mousedown', () => {
      this.pointerDownLink = this.activeLink;
    });
    element.addEventListener('mouseup', (event) => {
      const link = this.activeLink;
      if (link && this.pointerDownLink === link) link.activate(event, link.text);
      this.pointerDownLink = null;
    });
  }

  private syncViewport(): Promise<void> {
    if (this.viewportSyncPromise) return this.viewportSyncPromise;
    const sync = this.performViewportSync();
    this.viewportSyncPromise = sync;
    const clear = () => {
      if (this.viewportSyncPromise === sync) this.viewportSyncPromise = null;
    };
    void sync.then(clear, clear);
    return sync;
  }

  private async performViewportSync(): Promise<void> {
    if (this.disposed) return;
    const native = this.nativeValue;
    if (!native) return;
    let snapshot = await native.readBuffer();
    if (this.disposed) return;
    if (this.activeLink || this.linkDecorations.length > 0) this.clearActiveLink();
    let update = this.bufferValue.update(snapshot, this.colsValue);
    this.reconcileMarkers(update.trimmed, update.identityReset);
    if (update.missing) {
      snapshot = await native.readBuffer(update.missing);
      if (this.disposed) return;
      update = this.bufferValue.update(snapshot, this.colsValue);
      this.reconcileMarkers(update.trimmed, update.identityReset);
    }
    this.finalizeViewportUpdate(snapshot.state, { start: 0, end: Math.max(0, this.rowsValue - 1) });
  }

  private async applyCompatibilityBatch(batch: CoreCompatibilityBatch): Promise<void> {
    if (this.disposed) return;
    const native = this.nativeValue;
    if (!native) return;
    if (this.activeLink || this.linkDecorations.length > 0) this.clearActiveLink();
    let finalState: TerminalBufferState | null = null;
    let range: XtermRenderEvent | null = null;
    let normalTrimmed = 0;
    let normalReset = false;
    for (const update of batch.updates) {
      let bufferUpdate = this.bufferValue.update(
        {
          state: update.state,
          rows: update.rows,
          trimmed: update.trimmed,
          appendStart: update.appendStart,
          reset: update.reset,
        } satisfies PackedBufferSnapshot,
        this.colsValue
      );
      let state = update.state;
      if (state.screen === 'normal') {
        normalTrimmed += bufferUpdate.trimmed;
        normalReset ||= bufferUpdate.identityReset;
      }
      if (bufferUpdate.missing) {
        const snapshot = await native.readBuffer(bufferUpdate.missing);
        if (this.disposed) return;
        bufferUpdate = this.bufferValue.update(snapshot, this.colsValue);
        if (snapshot.state.screen === 'normal') {
          normalTrimmed += bufferUpdate.trimmed;
          normalReset ||= bufferUpdate.identityReset;
        }
        state = snapshot.state;
      }
      finalState = state;
      const updateRange = compatibilityRenderRange(update, state, this.rowsValue);
      if (updateRange) {
        range = range
          ? {
              start: Math.min(range.start, updateRange.start),
              end: Math.max(range.end, updateRange.end),
            }
          : updateRange;
      }
    }
    this.reconcileMarkers(normalTrimmed, normalReset);
    if (finalState) this.finalizeViewportUpdate(finalState, range);
  }

  private finalizeViewportUpdate(
    state: TerminalBufferState,
    renderRange: XtermRenderEvent | null
  ): void {
    if (state.modes) this.modeValues = { ...state.modes };
    if (state.cursorAttributes) {
      this.cursorAttributes = state.cursorAttributes;
      this._core._inputHandler._curAttrData.load(cursorAttributeCell(state.cursorAttributes));
    }
    const metrics = this.cssCellMetrics();
    if (this.scrollAreaValue) {
      const height = `${state.totalRows * metrics.cellHeightPx}px`;
      if (this.scrollAreaValue.style.height !== height) this.scrollAreaValue.style.height = height;
    }
    if (this.viewportValue) {
      this.syncingScrollbar = true;
      const scrollTop = state.viewportY * metrics.cellHeightPx;
      if (this.viewportValue.scrollTop !== scrollTop) this.viewportValue.scrollTop = scrollTop;
      queueMicrotask(() => {
        this.syncingScrollbar = false;
      });
    }
    if (this.decorations.size > 0) this.refreshDecorations();
    const cursor = `${state.cursorX}:${state.cursorY}`;
    if (cursor !== this.lastCursor) {
      this.lastCursor = cursor;
      this.cursorMoveEvent.fire(undefined);
    }
    if (renderRange) {
      this.pendingRenderRange = this.pendingRenderRange
        ? {
            start: Math.min(this.pendingRenderRange.start, renderRange.start),
            end: Math.max(this.pendingRenderRange.end, renderRange.end),
          }
        : renderRange;
    }
    if (this.selectionValue) this.refreshSelection();
    if (this.writeParsedEvent.hasListeners && !this.writeParsedQueued) {
      this.writeParsedQueued = true;
      queueMicrotask(() => {
        this.writeParsedQueued = false;
        if (!this.disposed) this.writeParsedEvent.fire(undefined);
      });
    }
  }

  private reconcileMarkers(trimmed: number, identityReset: boolean): void {
    if (this.buffer.active.type !== 'normal') return;
    if (identityReset) {
      for (const marker of [...this.markersValue]) marker.dispose();
      return;
    }
    if (trimmed > 0) {
      for (const marker of [...this.markersValue]) marker.trim(trimmed);
    }
  }

  private refreshDecorations(): void {
    for (const decoration of this.decorations) decoration.refresh();
  }

  private refreshSelection(notify = false): void {
    void this.nativeValue
      ?.getSelection()
      .then((value) => {
        if (this.disposed) return;
        const changed = value !== this.selectionValue;
        this.selectionValue = value;
        if (changed || notify) this.selectionEvent.fire(undefined);
      })
      .catch((error: unknown) => {
        if (!this.disposed) this.logError(error);
      });
  }

  private queueViewportSync(): void {
    void this.syncViewport().catch((error: unknown) => {
      if (!this.disposed) this.logError(error);
    });
  }

  private pointerSelection(startX: number, startY: number, endX: number, endY: number): void {
    this.queueNative((native) => {
      const geometry = native.geometry;
      const point = (x: number, y: number) => ({
        x: (x + 0.5) * geometry.cellWidthPx,
        y: (y - this.buffer.active.viewportY + 0.5) * geometry.cellHeightPx,
        forceSelection: true,
      });
      native.sendPointer({ action: 'press', button: 'left', ...point(startX, startY) });
      native.sendPointer({
        action: 'motion',
        anyButtonPressed: true,
        ...point(endX, endY),
      });
      native.sendPointer({ action: 'release', button: 'left', ...point(endX, endY) });
      this.refreshSelection();
    });
  }

  private updateLink(event: MouseEvent): void {
    const position = this.bufferPosition(event);
    this.lastLinkEvent = event;
    if (!position) {
      this.clearActiveLink(event);
      return;
    }
    if (this.activeLink && linkContains(this.activeLink, position.x, position.y)) return;
    this.clearActiveLink(event);
    const request = ++this.linkRequest;
    const providers = [...this.linkProviders];
    const oscLink = this.osc8Link(position.x, position.y);
    if (providers.length === 0) {
      if (oscLink) {
        this.activeLink = oscLink;
        oscLink.hover?.(event, oscLink.text);
        this.renderLinkDecorations(oscLink);
      }
      return;
    }
    void Promise.all(
      providers.map(
        (provider) =>
          new Promise<readonly ILink[] | undefined>((resolve) => {
            try {
              provider.provideLinks(position.y, resolve);
            } catch (error) {
              this.logError(error);
              resolve(undefined);
            }
          })
      )
    ).then((replies) => {
      if (request !== this.linkRequest || this.disposed) {
        disposeLinks(replies);
        return;
      }
      let active: ILink | undefined;
      for (const links of replies) {
        active = links?.find((link) => linkContains(link, position.x, position.y));
        if (active) break;
      }
      for (const links of replies) {
        for (const link of links ?? []) {
          if (link !== active) link.dispose?.();
        }
      }
      active ??= oscLink ?? undefined;
      if (!active) return;
      this.activeLink = active;
      active.hover?.(event, active.text);
      this.renderLinkDecorations(active);
    });
  }

  private osc8Link(x: number, y: number): ILink | null {
    const cell = this.bufferValue.cellAt(y - 1, x - 1);
    const uri = cell?.hyperlinkUri;
    if (!uri) return null;
    const handler = this.optionValues.linkHandler;
    if (!/^https?:\/\//iu.test(uri) && !handler?.allowNonHttpProtocols) return null;
    let start = x - 1;
    let end = x - 1;
    while (start > 0 && this.bufferValue.cellAt(y - 1, start - 1)?.hyperlinkUri === uri) start -= 1;
    while (
      end + 1 < this.colsValue &&
      this.bufferValue.cellAt(y - 1, end + 1)?.hyperlinkUri === uri
    )
      end += 1;
    const range: IBufferRange = {
      start: { x: start + 1, y },
      end: { x: end + 1, y },
    };
    return {
      text: uri,
      range,
      activate: (event, text) => {
        if (handler) {
          handler.activate(event, text, range);
          return;
        }
        const ownerWindow = this.elementValue?.ownerDocument.defaultView;
        if (ownerWindow?.confirm(`Open this terminal link?\n\n${text}`))
          ownerWindow.open(text, '_blank', 'noopener,noreferrer');
      },
      ...(handler?.hover
        ? { hover: (event: MouseEvent, text: string) => handler.hover?.(event, text, range) }
        : {}),
      ...(handler?.leave
        ? { leave: (event: MouseEvent, text: string) => handler.leave?.(event, text, range) }
        : {}),
    };
  }

  private bufferPosition(event: MouseEvent): { x: number; y: number } | null {
    const element = this.elementValue;
    const native = this.nativeValue;
    if (!element || !native) return null;
    const bounds = element.getBoundingClientRect();
    const relativeX = event.clientX - bounds.left;
    const relativeY = event.clientY - bounds.top;
    const metrics = this.cssCellMetrics();
    if (relativeX < 0 || relativeY < 0 || relativeX >= bounds.width || relativeY >= bounds.height)
      return null;
    if (
      relativeX >= metrics.cellWidthPx * this.colsValue ||
      relativeY >= metrics.cellHeightPx * this.rowsValue
    )
      return null;
    return {
      x: Math.floor(relativeX / metrics.cellWidthPx) + 1,
      y: this.buffer.active.viewportY + Math.floor(relativeY / metrics.cellHeightPx) + 1,
    };
  }

  private renderLinkDecorations(link: ILink): void {
    const element = this.elementValue;
    const native = this.nativeValue;
    if (!element || !native) return;
    const decorations = link.decorations;
    element.style.cursor = decorations?.pointerCursor === false ? '' : 'pointer';
    if (decorations?.underline === false) return;
    const { cellWidthPx, cellHeightPx } = this.cssCellMetrics();
    const viewportY = this.buffer.active.viewportY + 1;
    const firstRow = Math.max(link.range.start.y, viewportY);
    const lastRow = Math.min(link.range.end.y, viewportY + this.rowsValue - 1);
    for (let y = firstRow; y <= lastRow; y += 1) {
      const start = y === link.range.start.y ? link.range.start.x : 1;
      const end = y === link.range.end.y ? link.range.end.x : this.colsValue;
      const underline = element.ownerDocument.createElement('div');
      underline.className = 'xterm-link-decoration';
      underline.style.left = `${(start - 1) * cellWidthPx}px`;
      underline.style.top = `${(y - viewportY + 1) * cellHeightPx - 1}px`;
      underline.style.width = `${Math.max(1, end - start + 1) * cellWidthPx}px`;
      element.append(underline);
      this.linkDecorations.push(underline);
    }
  }

  private clearActiveLink(event?: MouseEvent): void {
    this.linkRequest += 1;
    const active = this.activeLink;
    if (active) {
      const lastEvent = event ?? this.lastLinkEvent;
      if (lastEvent) active.leave?.(lastEvent, active.text);
      active.dispose?.();
    }
    this.activeLink = null;
    this.pointerDownLink = null;
    if (this.elementValue) this.elementValue.style.cursor = '';
    for (const decoration of this.linkDecorations.splice(0)) decoration.remove();
  }

  private normalizeWrite(data: string | Uint8Array): string | Uint8Array {
    if (!this.optionValues.convertEol) return data;
    if (typeof data === 'string') {
      let value = '';
      let changed = false;
      let previousWasCarriageReturn = this.convertEolPreviousWasCarriageReturn;
      for (const character of data) {
        if (character === '\n' && !previousWasCarriageReturn) {
          value += '\r';
          changed = true;
        }
        value += character;
        previousWasCarriageReturn = character === '\r';
      }
      this.convertEolPreviousWasCarriageReturn = previousWasCarriageReturn;
      return changed ? value : data;
    }

    const startsWithCarriageReturn = this.convertEolPreviousWasCarriageReturn;
    let previousWasCarriageReturn = startsWithCarriageReturn;
    let bareLineFeeds = 0;
    for (const byte of data) {
      if (byte === 0x0a && !previousWasCarriageReturn) bareLineFeeds += 1;
      previousWasCarriageReturn = byte === 0x0d;
    }
    const endsWithCarriageReturn = previousWasCarriageReturn;
    this.convertEolPreviousWasCarriageReturn = endsWithCarriageReturn;
    if (bareLineFeeds === 0) return data;
    const value = new Uint8Array(data.byteLength + bareLineFeeds);
    let offset = 0;
    previousWasCarriageReturn = startsWithCarriageReturn;
    for (let index = 0; index < data.byteLength; index += 1) {
      const byte = data[index];
      if (byte === undefined) continue;
      if (byte === 0x0a && !previousWasCarriageReturn) value[offset++] = 0x0d;
      value[offset++] = byte;
      previousWasCarriageReturn = byte === 0x0d;
    }
    return value;
  }

  private emitLineFeeds(data: string | Uint8Array): void {
    if (!this.lineFeedEvent.hasListeners) return;
    let count = 0;
    if (typeof data === 'string') {
      for (let index = 0; index < data.length; index += 1) {
        if (data.charCodeAt(index) === 0x0a) count += 1;
      }
    } else {
      for (const byte of data) if (byte === 0x0a) count += 1;
    }
    for (let index = 0; index < count; index += 1) this.lineFeedEvent.fire(undefined);
  }

  private cssCellMetrics(): { cellWidthPx: number; cellHeightPx: number } {
    const native = this.nativeValue;
    const ratio = globalThis.devicePixelRatio || 1;
    return {
      cellWidthPx: (native?.geometry.cellWidthPx ?? 9) / ratio,
      cellHeightPx: (native?.geometry.cellHeightPx ?? 18) / ratio,
    };
  }

  private applyOptions(value: ITerminalOptions): void {
    this.assertActive();
    if (
      this.opened &&
      value.allowTransparency !== undefined &&
      value.allowTransparency !== this.optionValues.allowTransparency
    ) {
      throw new Error('allowTransparency is an init-only option and cannot change after open()');
    }
    const previous = this.optionValues;
    const next = applyValidatedOptions(previous, value, false);
    assertSupportedOptions(next);
    const convertEolChanged = next.convertEol !== previous.convertEol;
    this.optionValues = next;
    if (
      value.screenReaderMode !== undefined &&
      next.screenReaderMode !== previous.screenReaderMode
    ) {
      this.queueNative((native) =>
        native.setAccessibility(next.screenReaderMode ? 'full' : 'basic')
      );
    }
    if (
      value.minimumContrastRatio !== undefined &&
      next.minimumContrastRatio !== previous.minimumContrastRatio
    ) {
      this.queueNative((native) => native.setMinimumContrastRatio(next.minimumContrastRatio ?? 1));
    }
    if (convertEolChanged) this.convertEolPreviousWasCarriageReturn = false;
    if (value.theme !== undefined) {
      const theme = convertTheme(next.theme);
      if (theme) this.queueNative((native) => native.setTheme(theme));
      this._core._themeService.colors.ansi = xtermAnsiColors(next.theme);
    }
    const fontChanged =
      value.fontFamily !== undefined ||
      value.fontSize !== undefined ||
      value.fontWeight !== undefined ||
      value.fontWeightBold !== undefined ||
      value.letterSpacing !== undefined ||
      value.lineHeight !== undefined;
    if (fontChanged) {
      this.queueNative((native) =>
        native.setFont({
          family: this.optionValues.fontFamily ?? 'monospace',
          sizePx: this.optionValues.fontSize ?? 15,
          weight: this.optionValues.fontWeight ?? 'normal',
          boldWeight: this.optionValues.fontWeightBold ?? 'bold',
          letterSpacingPx: this.optionValues.letterSpacing ?? 0,
          lineHeight: this.optionValues.lineHeight ?? 1,
        })
      );
    }
    if (value.scrollback !== undefined && next.scrollback !== previous.scrollback) {
      this.bufferValue.reserveNormal(this.rowsValue + (next.scrollback ?? 1000));
      this.queueNative((native) => native.setScrollbackLines(next.scrollback ?? 1000));
      this.updateScrollbarGutter();
    }
    if (value.overviewRuler !== undefined) this.updateScrollbarGutter();
    if (
      (value.cursorStyle !== undefined || value.cursorBlink !== undefined) &&
      (next.cursorStyle !== previous.cursorStyle || next.cursorBlink !== previous.cursorBlink)
    ) {
      this.queueNative((native) =>
        native.setDefaultCursor(next.cursorStyle ?? 'block', next.cursorBlink ?? false)
      );
    }
    if (this.textareaValue) this.textareaValue.readOnly = next.disableStdin ?? false;
    this.applyTextareaStrings();
  }

  private applyTextareaStrings(): void {
    if (this.textareaValue)
      this.textareaValue.setAttribute('aria-label', Terminal.strings.promptLabel);
  }

  private updateScrollbarGutter(): void {
    const viewport = this.viewportValue;
    const screen = this.elementValue?.querySelector<HTMLElement>('.xterm-screen');
    if (!viewport || !screen) return;
    const width =
      this.optionValues.scrollback === 0 ? 0 : (this.optionValues.overviewRuler?.width ?? 14);
    viewport.style.display = width === 0 ? 'none' : '';
    viewport.style.width = `${width}px`;
    screen.style.right = `${width}px`;
  }

  private requireProposed(feature: string): void {
    if (!this.optionValues.allowProposedApi) {
      throw new XtermCompatibilityError(
        feature,
        `${feature} is a proposed xterm.js API; set allowProposedApi to true to use it`
      );
    }
  }

  private logError(error: unknown): void {
    const value = error instanceof Error ? error : new Error(String(error));
    if (this.optionValues.logger) this.optionValues.logger.error(value);
    else if (this.optionValues.logLevel !== 'off') console.error(value);
  }

  private queueNative(action: (native: GespenstTerminal) => unknown): void {
    this.assertActive();
    this.writeQueue = this.writeQueue
      .then(async () => {
        const native = await this.native;
        if (!this.disposed) await action(native);
      })
      .catch((error: unknown) => this.logError(error));
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Terminal is disposed');
  }

  private disposeEvents(): void {
    this.bellEvent.dispose();
    this.binaryEvent.dispose();
    this.cursorMoveEvent.dispose();
    this.dataEvent.dispose();
    this.keyEvent.dispose();
    this.lineFeedEvent.dispose();
    this.renderEvent.dispose();
    this.writeParsedEvent.dispose();
    this.resizeEvent.dispose();
    this.scrollEvent.dispose();
    this.selectionEvent.dispose();
    this.titleEvent.dispose();
  }
}

function normalizeDimension(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(65_535, Math.trunc(value)));
}

function compatibilityRenderRange(
  update: CoreCompatibilityUpdate,
  state: TerminalBufferState,
  rows: number
): XtermRenderEvent | null {
  if (update.dirty === 'full') return { start: 0, end: Math.max(0, rows - 1) };
  let start = rows;
  let end = -1;
  for (const row of update.rows) {
    const visible = row.index - state.viewportY;
    if (visible < 0 || visible >= rows) continue;
    start = Math.min(start, visible);
    end = Math.max(end, visible);
  }
  return end >= start ? { start, end } : null;
}

function verifyIntegers(...values: number[]): void {
  for (const value of values) {
    if (!Number.isFinite(value) || value % 1 !== 0)
      throw new Error('This API only accepts integers');
  }
}

function verifyPositiveIntegers(...values: number[]): void {
  for (const value of values) {
    if (value && (!Number.isFinite(value) || value % 1 !== 0 || value < 0))
      throw new Error('This API only accepts positive integers');
  }
}

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac/u.test(navigator.platform || navigator.userAgent);
}

function validDocument(value: unknown): Document | null {
  return value && typeof (value as Document).createElement === 'function'
    ? (value as Document)
    : null;
}

const FONT_WEIGHTS = new Set([
  'normal',
  'bold',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
]);

function applyValidatedOptions(
  current: ITerminalOptions,
  update: ITerminalOptions,
  initializing: boolean
): ITerminalOptions {
  const next = { ...current };
  for (const [rawKey, rawValue] of Object.entries(update)) {
    if (!(rawKey in DEFAULT_OPTIONS)) {
      const error = new Error(`No option with key "${rawKey}"`);
      if (initializing) {
        console.error(error);
        continue;
      }
      throw error;
    }
    const key = rawKey as keyof ITerminalOptions;
    try {
      (next as Record<string, unknown>)[key] = sanitizeOption(key, rawValue);
    } catch (error) {
      if (!initializing) throw error;
      console.error(error);
    }
  }
  return next;
}

function sanitizeOption(key: keyof ITerminalOptions, rawValue: unknown): unknown {
  let value = rawValue;
  if (key === 'cursorStyle') {
    value ||= DEFAULT_OPTIONS.cursorStyle;
    if (value !== 'block' && value !== 'underline' && value !== 'bar')
      throw new Error(`"${String(value)}" is not a valid value for cursorStyle`);
  } else if (key === 'wordSeparator') {
    value ||= DEFAULT_OPTIONS.wordSeparator;
  } else if (key === 'fontWeight' || key === 'fontWeightBold') {
    if (typeof value === 'number' && value >= 1 && value <= 1000) return value;
    value = typeof value === 'string' && FONT_WEIGHTS.has(value) ? value : DEFAULT_OPTIONS[key];
  } else if (key === 'cursorWidth') {
    value = Math.floor(Number(value));
    if ((value as number) < 1)
      throw new Error(`cursorWidth cannot be less than 1, value: ${String(value)}`);
  } else if (key === 'lineHeight' || key === 'tabStopWidth') {
    if (Number(value) < 1) throw new Error(`${key} cannot be less than 1, value: ${String(value)}`);
  } else if (key === 'minimumContrastRatio') {
    value = Math.max(1, Math.min(21, Math.round(Number(value) * 10) / 10));
  } else if (key === 'scrollback') {
    value = Math.min(Number(value), 0xffff_ffff);
    if ((value as number) < 0)
      throw new Error(`scrollback cannot be less than 0, value: ${String(value)}`);
  } else if (key === 'fastScrollSensitivity' || key === 'scrollSensitivity') {
    if (Number(value) <= 0)
      throw new Error(`${key} cannot be less than or equal to 0, value: ${String(value)}`);
  } else if (key === 'windowsPty') {
    value ??= {};
  }
  return value;
}

function assertSupportedOptions(options: ITerminalOptions): void {
  const unsupported = (feature: string, message: string): never => {
    throw new XtermCompatibilityError(feature, message);
  };
  if (options.tabStopWidth !== 8)
    unsupported('tabStopWidth', 'Ghostty currently exposes fixed 8-column tab stops');
  if (options.scrollOnEraseInDisplay)
    unsupported(
      'scrollOnEraseInDisplay',
      "Ghostty does not expose xterm's PuTTY-style ED2 scroll behavior"
    );
  if (options.reflowCursorLine)
    unsupported('reflowCursorLine', 'Ghostty owns resize reflow and does not expose this policy');
  if ((options.smoothScrollDuration ?? 0) !== 0)
    unsupported('smoothScrollDuration', 'Smooth scrolling is not implemented by @gespenst/xterm');
  if (options.windowsPty && Object.keys(options.windowsPty).length > 0)
    unsupported('windowsPty', 'ConPTY-specific xterm heuristics are not implemented over Ghostty');
  if (options.windowOptions && Object.values(options.windowOptions).some(Boolean))
    unsupported('windowOptions', 'xterm window manipulation options are not exposed by Ghostty');
}

function createOptionsProxy(
  read: () => ITerminalOptions,
  write: (property: keyof ITerminalOptions, value: unknown) => void
): ITerminalOptions {
  return new Proxy({} as ITerminalOptions, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined;
      if (!(property in DEFAULT_OPTIONS)) throw new Error(`No option with key "${property}"`);
      return (read() as Record<string, unknown>)[property];
    },
    set: (_target, property, value) => {
      if (typeof property !== 'string' || !(property in DEFAULT_OPTIONS))
        throw new Error(`No option with key "${String(property)}"`);
      write(property as keyof ITerminalOptions, value);
      return true;
    },
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, property) =>
      property in read() ? { enumerable: true, configurable: true } : undefined,
  });
}

interface XtermInternalColor {
  readonly css: string;
  readonly rgba: number;
}

function xtermAnsiColors(theme: ITheme | undefined): XtermInternalColor[] {
  const resolved = resolveTerminalTheme(convertTheme(theme));
  return resolved.palette.map((color) => ({
    css: terminalColorToCss(color),
    rgba: ((color.r << 24) | (color.g << 16) | (color.b << 8) | 0xff) >>> 0,
  }));
}

function cursorAttributeCell(attributes: TerminalCursorAttributes): RenderCell {
  return {
    x: 0,
    text: '',
    width: 'narrow',
    style: attributes.style,
    foreground: attributes.foreground.mode === 'rgb' ? attributes.foreground.value : null,
    background: attributes.background.mode === 'rgb' ? attributes.background.value : null,
    foregroundSource: attributes.foreground,
    backgroundSource: attributes.background,
    underlineSource: attributes.underline,
    hyperlink: false,
    hyperlinkUri: null,
    semanticContent: 'unknown',
  };
}

function isModifierKey(event: KeyboardEvent): boolean {
  return [
    'Alt',
    'AltGraph',
    'CapsLock',
    'Control',
    'Meta',
    'NumLock',
    'ScrollLock',
    'Shift',
  ].includes(event.key);
}

function convertTheme(theme: ITheme | undefined): TerminalTheme | undefined {
  if (!theme) return undefined;
  const output: Record<string, unknown> = {};
  for (const name of [
    'foreground',
    'background',
    'cursor',
    'cursorAccent',
    'selectionBackground',
    'selectionForeground',
    'selectionInactiveBackground',
    ...ANSI_COLOR_NAMES,
  ] as const) {
    const value = theme[name];
    const normalized = normalizeXtermColor(value);
    if (normalized) output[name] = normalized;
  }
  if (theme.extendedAnsi) {
    const defaults = resolveTerminalTheme().palette.slice(16);
    output.extendedAnsi = theme.extendedAnsi.map(
      (value, index) =>
        normalizeXtermColor(value) ??
        terminalColorToCss(defaults[index] ?? resolveTerminalTheme().foreground)
    );
  }
  return output as TerminalTheme;
}

const xtermColorCache = new Map<string, string | null>();

function normalizeXtermColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cached = xtermColorCache.get(value);
  if (cached !== undefined) return cached ?? undefined;
  try {
    parseTerminalColor(value);
    xtermColorCache.set(value, value);
    return value;
  } catch {
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    const context = canvas?.getContext('2d');
    if (!context) {
      xtermColorCache.set(value, null);
      return undefined;
    }
    context.fillStyle = '#010203';
    context.fillStyle = value;
    const first = context.fillStyle;
    context.fillStyle = '#040506';
    context.fillStyle = value;
    const second = context.fillStyle;
    if (first === '#010203' && second === '#040506') {
      xtermColorCache.set(value, null);
      return undefined;
    }
    try {
      parseTerminalColor(second);
      xtermColorCache.set(value, second);
      return second;
    } catch {
      xtermColorCache.set(value, null);
      return undefined;
    }
  }
}

/** Converts a Gespenst theme, including structured colors and legacy palettes, to xterm `ITheme`. */
export function toXtermTheme(theme: TerminalTheme): ITheme {
  const resolved = resolveTerminalTheme(theme);
  const output: ITheme = {
    foreground: terminalColorToCss(resolved.foreground),
    background: terminalColorToCss(resolved.background),
    cursor: terminalColorToCss(resolved.cursor),
    cursorAccent: terminalColorToCss(resolved.cursorAccent),
    selectionBackground: terminalColorToCss(resolved.selectionBackground),
    selectionInactiveBackground: terminalColorToCss(resolved.selectionInactiveBackground),
    ...(resolved.selectionForeground
      ? { selectionForeground: terminalColorToCss(resolved.selectionForeground) }
      : {}),
  };
  ANSI_COLOR_NAMES.forEach((name, index) => {
    output[name] = terminalColorToCss(resolved.palette[index] ?? resolved.foreground);
  });
  output.extendedAnsi = resolved.palette.slice(16).map(terminalColorToCss);
  return output;
}

function linkContains(link: ILink, x: number, y: number): boolean {
  const { start, end } = link.range;
  if (y < start.y || y > end.y) return false;
  if (y === start.y && x < start.x) return false;
  if (y === end.y && x > end.x) return false;
  return true;
}

function disposeLinks(replies: readonly (readonly ILink[] | undefined)[]): void {
  for (const links of replies) {
    for (const link of links ?? []) link.dispose?.();
  }
}

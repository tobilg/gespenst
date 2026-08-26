import type { Allocation, GhosttyBindings } from './bindings.js';
import { BufferReader } from './buffer.js';
import { TypedEventEmitter } from './events.js';
import { InputEncoder } from './input.js';
import { PointerController } from './pointer.js';
import { RenderReader } from './render.js';
import {
  cloneTerminalTheme,
  mergeTerminalTheme,
  type PaletteGenerator,
  resolveTerminalTheme,
} from './theme.js';
import type {
  ClipboardContent,
  ClipboardLocation,
  ClipboardPasteRequest,
  ClipboardPasteResult,
  ClipboardProtocolOptions,
  ClipboardWriteRequest,
  CoreTerminalOptions,
  Disposable,
  KeyInput,
  PointerInput,
  PointerResult,
  ProgressState,
  RenderColor,
  RenderFrame,
  RenderRow,
  ResolvedTerminalTheme,
  RgbColor,
  SelectionFormatOptions,
  TerminalBufferRange,
  TerminalBufferSnapshot,
  TerminalBufferState,
  TerminalEventMap,
  TerminalGeometry,
  TerminalTheme,
  ViewportSnapshot,
} from './types.js';

type Effect =
  | { readonly type: 'input'; readonly data: Uint8Array }
  | { readonly type: 'bell' | 'title' | 'cwd' }
  | { readonly type: 'notification'; readonly title: string; readonly body: string }
  | { readonly type: 'progress'; readonly state: ProgressState; readonly progress: number | null }
  | { readonly type: 'clipboardWrite'; readonly request: ClipboardWriteRequest }
  | { readonly type: 'error'; readonly error: Error };

export interface TerminalHost {
  readonly bindings: GhosttyBindings;
  readonly callbackIndexes: Readonly<{
    writePty: number;
    bell: number;
    titleChanged: number;
    pwdChanged: number;
    desktopNotification: number;
    progressReport: number;
    clipboardRead: number;
    clipboardWrite: number;
    mimeReader: number;
    randomSecure: number;
    colorScheme: number;
  }>;
  unregister(id: number): void;
}

/** Headless terminal exposing Ghostty VT parsing, input encoding, selection, and snapshots. */
export class CoreTerminal implements Disposable {
  private handle: number;
  private readonly inputEncoder: InputEncoder;
  private readonly renderReader: RenderReader;
  private readonly bufferReader: BufferReader;
  private readonly pointerController: PointerController;
  private readonly events = new TypedEventEmitter<TerminalEventMap>();
  private readonly effects: Effect[] = [];
  private currentThemeSource: TerminalTheme;
  private currentTheme: ResolvedTerminalTheme;
  private themeAlpha = new Map<string, number>();
  private disposed = false;
  private writing = false;
  private revision = 0;
  private _geometry: TerminalGeometry;
  private readonly host: TerminalHost;
  private clipboardEnabled = false;
  private clipboardMaxBytes = 32 * 1024 * 1024;
  private clipboardSnapshotTtlMs = 30_000;
  private clipboardSnapshot: {
    readonly location: ClipboardLocation;
    readonly contents: readonly ClipboardContent[];
  } | null = null;
  private clipboardSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Runtime-unique terminal identifier. */
  readonly id: number;

  constructor(host: TerminalHost, id: number, options: CoreTerminalOptions = {}) {
    this.host = host;
    this.id = id;
    const cols = Math.max(1, Math.min(65_535, Math.floor(options.cols ?? 80)));
    const rows = Math.max(1, Math.min(65_535, Math.floor(options.rows ?? 24)));
    const cellWidthPx = Math.max(1, Math.floor(options.cellWidthPx ?? 9));
    const cellHeightPx = Math.max(1, Math.floor(options.cellHeightPx ?? 18));
    this.handle = host.bindings.createHandle('ghostty_terminal_new', (slot) =>
      host.bindings.exports.ghostty_terminal_new(0, slot, cols, rows)
    );
    this.inputEncoder = new InputEncoder(host.bindings);
    this.renderReader = new RenderReader(host.bindings);
    this.bufferReader = new BufferReader(host.bindings);
    this.pointerController = new PointerController(host.bindings);
    this._geometry = {
      cols,
      rows,
      cellWidthPx,
      cellHeightPx,
      widthPx: cols * cellWidthPx,
      heightPx: rows * cellHeightPx,
    };
    this.currentThemeSource = cloneTerminalTheme(options.theme ?? {});
    this.currentTheme = resolveTerminalTheme(this.currentThemeSource, this.generatePalette);
    this.rebuildThemeAlpha();
    this.configure(
      options.scrollbackLines ?? 10_000,
      options.defaultCursorStyle ?? 'block',
      options.defaultCursorBlink ?? false
    );
  }

  /** Current grid and cell geometry. */
  get geometry(): TerminalGeometry {
    return this._geometry;
  }

  /** Current authored theme. Missing properties inherit from {@link DEFAULT_THEME}. */
  get theme(): Readonly<TerminalTheme> {
    return this.currentThemeSource;
  }

  /** Subscribes to a typed headless terminal event. */
  on<Key extends keyof TerminalEventMap>(
    type: Key,
    listener: (value: TerminalEventMap[Key]) => void
  ): Disposable {
    return this.events.on(type, listener);
  }

  /** Parses terminal output and flushes resulting callbacks. */
  write(data: string | Uint8Array): void {
    this.ensureActive();
    if (this.writing) throw new Error('CoreTerminal.write() is not reentrant');
    this.writing = true;
    try {
      this.host.bindings.withBytes(data, (pointer, length) =>
        this.host.bindings.exports.ghostty_terminal_vt_write(this.handle, pointer, length)
      );
    } finally {
      this.writing = false;
      this.revision += 1;
      this.flushEffects();
    }
  }

  /** Applies character-grid and cell-size geometry. */
  resize(
    cols: number,
    rows: number,
    cellWidthPx = this._geometry.cellWidthPx,
    cellHeightPx = this._geometry.cellHeightPx
  ): void {
    this.ensureActive();
    const next = {
      cols: Math.max(1, Math.min(65_535, Math.floor(cols))),
      rows: Math.max(1, Math.min(65_535, Math.floor(rows))),
      cellWidthPx: Math.max(1, Math.floor(cellWidthPx)),
      cellHeightPx: Math.max(1, Math.floor(cellHeightPx)),
    };
    this.host.bindings.check(
      this.host.bindings.exports.ghostty_terminal_resize(
        this.handle,
        next.cols,
        next.rows,
        next.cellWidthPx,
        next.cellHeightPx
      ),
      'resize terminal'
    );
    this._geometry = {
      ...next,
      widthPx: next.cols * next.cellWidthPx,
      heightPx: next.rows * next.cellHeightPx,
    };
    this.renderReader.invalidate();
    this.revision += 1;
  }

  /** Resets Ghostty terminal state and invalidates the viewport. */
  reset(): void {
    this.ensureActive();
    this.host.bindings.exports.ghostty_terminal_reset(this.handle);
    this.clearClipboardSnapshot();
    this.renderReader.invalidate();
    this.revision += 1;
  }

  /** Reads the current incremental render frame. */
  render(): RenderFrame {
    this.ensureActive();
    const frame = this.decorateFrame(this.renderReader.read(this.handle));
    this.events.emit('render', frame);
    return frame;
  }

  /** Reads a complete visible viewport snapshot. */
  viewport(): ViewportSnapshot {
    this.ensureActive();
    return this.decorateViewport(this.renderReader.snapshot(this.handle));
  }

  /** Returns authoritative active-buffer metadata. */
  bufferState(): TerminalBufferState {
    this.ensureActive();
    return this.bufferReader.state(this.handle, this.revision);
  }

  /** Changes the retained scrollback capacity without resetting terminal contents. */
  setScrollbackLines(lines: number): void {
    this.ensureActive();
    this.setScalarOption('SCROLLBACK_MAX_LINES', lines);
    this.revision += 1;
  }

  /** Changes the default cursor shape and blink behavior used by Ghostty. */
  setDefaultCursor(style: import('./types.js').CursorStyle, blink: boolean): void {
    this.ensureActive();
    const cursor = this.host.bindings.alloc(4);
    const blinking = this.host.bindings.alloc(1);
    try {
      cursor.view.setInt32(
        0,
        this.host.bindings.abi.value(
          'GhosttyTerminalCursorStyle',
          style.replace('-', '_').toUpperCase()
        ),
        true
      );
      blinking.view.setUint8(0, blink ? 1 : 0);
      this.setOption('DEFAULT_CURSOR_STYLE', cursor.pointer);
      this.setOption('DEFAULT_CURSOR_BLINK', blinking.pointer);
      this.renderReader.invalidate();
      this.revision += 1;
    } finally {
      cursor.free();
      blinking.free();
    }
  }

  /** Reads a clamped page of active-buffer rows; defaults to the visible viewport. */
  readBuffer(range?: TerminalBufferRange): TerminalBufferSnapshot {
    this.ensureActive();
    return this.bufferReader.read(this.handle, this.revision, this.currentTheme, range);
  }

  /** Encodes a physical key input and emits resulting PTY bytes. */
  key(input: KeyInput): Uint8Array {
    return this.emitInput(this.inputEncoder.key(this.handle, input), 'key');
  }

  /** Encodes composed text input and emits resulting PTY bytes. */
  text(data: string | Uint8Array): Uint8Array {
    return this.emitInput(this.inputEncoder.text(data), 'text');
  }

  /** Encodes pasted content, honoring bracketed-paste mode. */
  paste(data: string | Uint8Array): Uint8Array {
    return this.emitInput(this.inputEncoder.paste(data, this.isMode(2004)), 'paste');
  }

  /** Enables Kitty clipboard paste events and returns an idempotent registration. */
  enableClipboard(options: ClipboardProtocolOptions = {}): Disposable {
    this.ensureActive();
    if (this.clipboardEnabled) throw new Error('Clipboard protocol is already enabled');
    this.clipboardMaxBytes = normalizeClipboardLimit(options.maxBytes);
    this.clipboardSnapshotTtlMs = normalizeClipboardTtl(options.snapshotTtlMs);
    this.setOption('CLIPBOARD_READ', this.host.callbackIndexes.clipboardRead);
    this.setScalarOption('CLIPBOARD_WRITE_MAX_BYTES', this.clipboardMaxBytes);
    this.clipboardEnabled = true;
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        if (!this.disposed) this.disableClipboard();
      },
    };
  }

  /** Applies user-initiated MIME data using Kitty paste events when mode 5522 is active. */
  pasteClipboard(request: ClipboardPasteRequest): ClipboardPasteResult {
    this.ensureActive();
    if (!this.clipboardEnabled) throw new Error('Clipboard protocol is not enabled');
    const contents = normalizeClipboardContents(request.contents, this.clipboardMaxBytes);
    if (contents.length === 0) return { status: 'empty' };
    if (this.isMode(5522))
      return this.pasteClipboardEvent(contents, request.location ?? 'standard');

    const text = contents.find((content) => isTextMime(content.mime));
    if (!text || text.data.byteLength === 0) return { status: 'empty' };
    if (!request.allowUnsafe && this.isUnsafeTextPaste(text.data)) return { status: 'unsafe' };
    this.paste(text.data);
    return { status: 'written', kind: 'text' };
  }

  /** @internal Replies synchronously to a Ghostty clipboard read callback. */
  replyClipboardRead(request: number): void {
    const bindings = this.host.bindings;
    const abi = bindings.abi;
    const view = new DataView(bindings.exports.memory.buffer);
    const replyIndex = view.getUint32(
      request + abi.field('GhosttyClipboardRead', 'reply').offset,
      true
    );
    const reply = bindings.allocType('GhosttyClipboardReadReply', true);
    const allocations = [reply];
    try {
      const list = view.getUint8(request + abi.field('GhosttyClipboardRead', 'list').offset) !== 0;
      const granted =
        view.getUint8(request + abi.field('GhosttyClipboardRead', 'granted').offset) !== 0;
      const snapshot = this.clipboardSnapshot;
      const location = clipboardLocationFromValue(
        view.getInt32(request + abi.field('GhosttyClipboardRead', 'location').offset, true)
      );
      const mimes = readStringArray(
        bindings,
        view.getUint32(request + abi.field('GhosttyClipboardRead', 'mimes').offset, true),
        view.getUint32(request + abi.field('GhosttyClipboardRead', 'mimes_len').offset, true)
      );
      const result =
        snapshot && snapshot.location === location && (list || granted) ? 'SUCCESS' : 'DENIED';
      reply.view.setInt32(
        abi.field('GhosttyClipboardReadReply', 'result').offset,
        abi.value('GhosttyClipboardReadResult', result),
        true
      );
      if (snapshot && result === 'SUCCESS') {
        if (list) {
          const available = allocateStrings(
            bindings,
            snapshot.contents.map((content) => content.mime)
          );
          allocations.push(...available.allocations);
          reply.view.setUint32(
            abi.field('GhosttyClipboardReadReply', 'available').offset,
            available.pointer,
            true
          );
          reply.view.setUint32(
            abi.field('GhosttyClipboardReadReply', 'available_len').offset,
            snapshot.contents.length,
            true
          );
        }
        if (mimes.length > 0 && granted) {
          const selected = mimes.flatMap((mime) => {
            const content = snapshot.contents.find((candidate) => candidate.mime === mime);
            return content ? [content] : [];
          });
          const encoded = allocateClipboardContents(bindings, selected);
          allocations.push(...encoded.allocations);
          reply.view.setUint32(
            abi.field('GhosttyClipboardReadReply', 'contents').offset,
            encoded.pointer,
            true
          );
          reply.view.setUint32(
            abi.field('GhosttyClipboardReadReply', 'contents_len').offset,
            selected.length,
            true
          );
        }
      }
      callTable(bindings, replyIndex, request, reply.pointer);
      if (result === 'SUCCESS' && granted && mimes.length > 0) this.clearClipboardSnapshot();
    } finally {
      for (const allocation of allocations.reverse()) allocation.free();
    }
  }

  /** @internal Denies remote clipboard writes and emits the request for auditing. */
  replyClipboardWrite(request: number, value: ClipboardWriteRequest): void {
    const bindings = this.host.bindings;
    const abi = bindings.abi;
    const view = new DataView(bindings.exports.memory.buffer);
    const replyIndex = view.getUint32(
      request + abi.field('GhosttyClipboardWrite', 'reply').offset,
      true
    );
    const reply = bindings.allocType('GhosttyClipboardWriteReply', true);
    try {
      reply.view.setInt32(
        abi.field('GhosttyClipboardWriteReply', 'result').offset,
        abi.value('GhosttyClipboardWriteResult', this.clipboardEnabled ? 'DENIED' : 'UNSUPPORTED'),
        true
      );
      callTable(bindings, replyIndex, request, reply.pointer);
      this.queueEffect({ type: 'clipboardWrite', request: value });
    } finally {
      reply.free();
    }
  }

  /** Encodes a focus transition when focus reporting is enabled. */
  focus(focused: boolean): Uint8Array {
    if (!this.isMode(1004)) return new Uint8Array();
    return this.emitInput(this.inputEncoder.focus(focused), 'focus');
  }

  /** Encodes a pointer action or updates terminal selection. */
  pointer(input: PointerInput): PointerResult {
    this.ensureActive();
    const result = this.pointerController.handle(this.handle, input, this._geometry);
    if (result.data.length > 0) this.events.emit('input', { data: result.data, source: 'mouse' });
    return result;
  }

  /** Applies a wheel gesture as mouse tracking input or viewport scrolling. */
  wheel(input: PointerInput, lines: number): void {
    this.ensureActive();
    if (!input.forceSelection && this.pointerController.tracking(this.handle) !== 0) {
      this.pointer(input);
    } else {
      this.scrollLines(lines);
    }
  }

  /** Returns whether an ANSI or DEC terminal mode is enabled. */
  isMode(mode: number, ansi = false): boolean {
    this.ensureActive();
    const value = this.host.bindings.allocType('GhosttyTerminalModeConfig');
    try {
      const modeValue = (mode & 0x7fff) | (ansi ? 0x8000 : 0);
      value.view.setUint16(
        this.host.bindings.abi.field('GhosttyTerminalModeConfig', 'mode').offset,
        modeValue,
        true
      );
      this.host.bindings.check(
        this.host.bindings.exports.ghostty_terminal_get(
          this.handle,
          this.host.bindings.abi.value('GhosttyTerminalData', 'MODE'),
          value.pointer
        ),
        `query terminal mode ${mode}`
      );
      return (
        value.view.getUint8(
          this.host.bindings.abi.field('GhosttyTerminalModeConfig', 'value').offset
        ) !== 0
      );
    } finally {
      value.free();
    }
  }

  /** Scrolls the viewport by a signed line delta. */
  scrollLines(delta: number): void {
    this.scroll('DELTA', Math.trunc(delta));
  }

  /** Scrolls to the beginning of the buffer. */
  scrollToTop(): void {
    this.scroll('TOP', 0);
  }

  /** Scrolls to the end of the buffer. */
  scrollToBottom(): void {
    this.scroll('BOTTOM', 0);
  }

  /** Selects all terminal buffer content. */
  selectAll(): void {
    this.ensureActive();
    const selection = this.host.bindings.allocType('GhosttySelection', true);
    try {
      this.host.bindings.check(
        this.host.bindings.exports.ghostty_terminal_select_all(this.handle, selection.pointer),
        'select all'
      );
      this.setOption('SELECTION', selection.pointer);
    } finally {
      selection.free();
    }
  }

  /** Clears the current text selection. */
  clearSelection(): void {
    this.ensureActive();
    this.setOption('SELECTION', 0);
  }

  /** Returns selected content using the requested output format. */
  getSelection(options: SelectionFormatOptions = {}): string {
    this.ensureActive();
    const format = this.host.bindings.allocType('GhosttyTerminalSelectionFormatOptions', true);
    const written = this.host.bindings.alloc(4);
    try {
      const abi = this.host.bindings.abi;
      format.view.setInt32(
        abi.field('GhosttyTerminalSelectionFormatOptions', 'emit').offset,
        abi.value('GhosttyFormatterFormat', (options.format ?? 'plain').toUpperCase()),
        true
      );
      format.view.setUint8(
        abi.field('GhosttyTerminalSelectionFormatOptions', 'unwrap').offset,
        options.unwrap === false ? 0 : 1
      );
      format.view.setUint8(
        abi.field('GhosttyTerminalSelectionFormatOptions', 'trim').offset,
        options.trim ? 1 : 0
      );
      const result = this.host.bindings.exports.ghostty_terminal_selection_format_buf(
        this.handle,
        format.pointer,
        0,
        0,
        written.pointer
      );
      if (result === abi.value('GhosttyResult', 'NO_VALUE')) return '';
      if (result !== abi.value('GhosttyResult', 'OUT_OF_SPACE') && result !== 0) {
        this.host.bindings.check(result, 'measure selection');
      }
      const length = written.view.getUint32(0, true);
      if (length === 0) return '';
      const output = this.host.bindings.alloc(length);
      try {
        this.host.bindings.check(
          this.host.bindings.exports.ghostty_terminal_selection_format_buf(
            this.handle,
            format.pointer,
            output.pointer,
            output.length,
            written.pointer
          ),
          'format selection'
        );
        return this.host.bindings.readString(output.pointer, written.view.getUint32(0, true));
      } finally {
        output.free();
      }
    } finally {
      format.free();
      written.free();
    }
  }

  /** Replaces terminal colors and invalidates the render state. */
  async setTheme(theme: TerminalTheme): Promise<void> {
    this.ensureActive();
    this.currentThemeSource = cloneTerminalTheme(theme);
    this.currentTheme = resolveTerminalTheme(this.currentThemeSource, this.generatePalette);
    this.rebuildThemeAlpha();
    this.applyTheme();
  }

  /** Patches the current theme without resetting unspecified properties. */
  async updateTheme(theme: TerminalTheme): Promise<void> {
    return this.setTheme(mergeTerminalTheme(this.currentThemeSource, theme));
  }

  /** Serializes Ghostty terminal state and geometry. */
  snapshot(): Uint8Array {
    this.ensureActive();
    const written = this.host.bindings.alloc(4);
    try {
      const e = this.host.bindings.exports;
      const measured = e.ghostty_snapshot_encode_buf(this.handle, 0, 0, written.pointer);
      const outOfSpace = this.host.bindings.abi.value('GhosttyResult', 'OUT_OF_SPACE');
      if (measured !== outOfSpace && measured !== 0) {
        this.host.bindings.check(measured, 'measure terminal snapshot');
      }
      const output = this.host.bindings.alloc(written.view.getUint32(0, true));
      try {
        this.host.bindings.check(
          e.ghostty_snapshot_encode_buf(
            this.handle,
            output.pointer,
            output.length,
            written.pointer
          ),
          'encode terminal snapshot'
        );
        return output.bytes.slice(0, written.view.getUint32(0, true));
      } finally {
        output.free();
      }
    } finally {
      written.free();
    }
  }

  /** Restores a compatible snapshot and its saved geometry. */
  restore(snapshot: Uint8Array): void {
    this.ensureActive();
    this.clearClipboardSnapshot();
    this.pointerController.resetSelection(this.handle);
    this.host.bindings.withBytes(snapshot, (pointer, length) => {
      const e = this.host.bindings.exports;
      const decoder = this.host.bindings.createHandle('ghostty_snapshot_decoder_new_buf', (slot) =>
        e.ghostty_snapshot_decoder_new_buf(0, slot, pointer, length)
      );
      const terminalSlot = e.ghostty_wasm_alloc_opaque();
      if (!terminalSlot) {
        e.ghostty_snapshot_decoder_free(decoder);
        throw new Error('Failed to allocate restored terminal handle');
      }
      try {
        this.host.bindings.check(
          e.ghostty_snapshot_decoder_decode(decoder, terminalSlot),
          'decode terminal snapshot'
        );
        const restored = e.ghostty_wasm_take_opaque(terminalSlot);
        if (!restored) throw new Error('Snapshot decoder returned a null terminal');
        e.ghostty_terminal_free(this.handle);
        this.handle = restored;
      } finally {
        e.ghostty_wasm_free_opaque(terminalSlot);
        e.ghostty_snapshot_decoder_free(decoder);
      }
    });
    this.configure();
    this.syncGeometry();
    this.renderReader.invalidate();
    this.revision += 1;
  }

  /** Releases the Ghostty handle and unregisters the terminal from its runtime. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearClipboardSnapshot();
    this.host.unregister(this.id);
    this.inputEncoder.dispose();
    this.renderReader.dispose();
    this.bufferReader.dispose();
    this.pointerController.dispose(this.handle);
    this.host.bindings.exports.ghostty_terminal_free(this.handle);
    this.effects.length = 0;
    this.events.clear();
  }

  /** @internal Called synchronously by the WASM callback router. */
  /** @internal */
  queueEffect(effect: Effect): void {
    this.effects.push(effect);
  }

  /** @internal Writes Ghostty's color-scheme callback result. */
  writeColorScheme(pointer: number): number {
    if (!pointer) return 0;
    new DataView(this.host.bindings.exports.memory.buffer).setInt32(
      pointer,
      this.currentTheme.appearance === 'light' ? 0 : 1,
      true
    );
    return 1;
  }

  private configure(
    scrollbackLines?: number,
    cursorStyle?: import('./types.js').CursorStyle,
    cursorBlink?: boolean
  ): void {
    this.setOption('USERDATA', this.id);
    const callbacks = this.host.callbackIndexes;
    this.setOption('WRITE_PTY', callbacks.writePty);
    this.setOption('BELL', callbacks.bell);
    this.setOption('TITLE_CHANGED', callbacks.titleChanged);
    this.setOption('PWD_CHANGED', callbacks.pwdChanged);
    this.setOption('DESKTOP_NOTIFICATION', callbacks.desktopNotification);
    this.setOption('PROGRESS_REPORT', callbacks.progressReport);
    this.setOption('CLIPBOARD_WRITE', callbacks.clipboardWrite);
    if (this.clipboardEnabled) {
      this.setOption('CLIPBOARD_READ', callbacks.clipboardRead);
      this.setScalarOption('CLIPBOARD_WRITE_MAX_BYTES', this.clipboardMaxBytes);
    }
    this.setOption('COLOR_SCHEME', callbacks.colorScheme);
    if (scrollbackLines !== undefined)
      this.setScalarOption('SCROLLBACK_MAX_LINES', scrollbackLines);
    if (cursorStyle !== undefined) this.setDefaultCursor(cursorStyle, cursorBlink ?? false);
    this.applyTheme();
  }

  private disableClipboard(): void {
    this.setOption('CLIPBOARD_READ', 0);
    this.clearClipboardSnapshot();
    this.clipboardEnabled = false;
  }

  private pasteClipboardEvent(
    contents: readonly ClipboardContent[],
    location: ClipboardLocation
  ): ClipboardPasteResult {
    const bindings = this.host.bindings;
    const abi = bindings.abi;
    const paste = bindings.allocType('GhosttyPaste', true);
    const written = bindings.alloc(1);
    const mimes = allocateStrings(
      bindings,
      contents.map((content) => content.mime)
    );
    try {
      paste.view.setInt32(
        abi.field('GhosttyPaste', 'location').offset,
        clipboardLocationValue(bindings, location),
        true
      );
      paste.view.setInt32(
        abi.field('GhosttyPaste', 'source').offset,
        abi.value('GhosttyPasteSource', 'CLIPBOARD'),
        true
      );
      paste.view.setUint32(abi.field('GhosttyPaste', 'mimes').offset, mimes.pointer, true);
      paste.view.setUint32(abi.field('GhosttyPaste', 'mimes_len').offset, contents.length, true);
      const readerOffset = abi.field('GhosttyPaste', 'reader').offset;
      paste.view.setUint32(
        readerOffset + abi.field('GhosttyMimeReader', 'read').offset,
        this.host.callbackIndexes.mimeReader,
        true
      );
      paste.view.setUint32(
        readerOffset + abi.field('GhosttyMimeReader', 'userdata').offset,
        this.id,
        true
      );
      this.setClipboardSnapshot(contents, location);
      const result = bindings.exports.ghostty_terminal_paste(
        this.handle,
        paste.pointer,
        written.pointer
      );
      this.flushEffects();
      if (result !== 0) {
        this.clearClipboardSnapshot();
        bindings.check(result, 'paste clipboard contents');
      }
      if (written.view.getUint8(0) === 0) {
        this.clearClipboardSnapshot();
        return { status: 'empty' };
      }
      return { status: 'written', kind: 'kitty' };
    } finally {
      written.free();
      paste.free();
      for (const allocation of mimes.allocations.reverse()) allocation.free();
    }
  }

  private isUnsafeTextPaste(data: Uint8Array): boolean {
    const value = new TextDecoder().decode(data);
    return value.includes('\x1b[201~') || (!this.isMode(2004) && /[\r\n]/u.test(value));
  }

  private setClipboardSnapshot(
    contents: readonly ClipboardContent[],
    location: ClipboardLocation
  ): void {
    this.clearClipboardSnapshot();
    this.clipboardSnapshot = {
      location,
      contents: contents.map((content) => ({
        mime: content.mime,
        data: content.data.slice(),
      })),
    };
    this.clipboardSnapshotTimer = setTimeout(
      () => this.clearClipboardSnapshot(),
      this.clipboardSnapshotTtlMs
    );
  }

  private clearClipboardSnapshot(): void {
    if (this.clipboardSnapshotTimer !== null) clearTimeout(this.clipboardSnapshotTimer);
    this.clipboardSnapshotTimer = null;
    this.clipboardSnapshot = null;
  }

  private applyTheme(): void {
    const color = this.host.bindings.allocType('GhosttyColorRgb');
    const palette = this.host.bindings.alloc(256 * 3);
    try {
      for (const [name, value] of [
        ['COLOR_FOREGROUND', this.currentTheme.foreground],
        ['COLOR_BACKGROUND', this.currentTheme.background],
        ['COLOR_CURSOR', this.currentTheme.cursor],
      ] as const) {
        this.host.bindings.writeColor(color.pointer, value);
        this.setOption(name, color.pointer);
      }
      this.currentTheme.palette.forEach((value, index) => {
        this.host.bindings.writeColor(palette.pointer + index * 3, value);
      });
      this.setOption('COLOR_PALETTE', palette.pointer);
    } finally {
      color.free();
      palette.free();
    }
  }

  private readonly generatePalette: PaletteGenerator = (
    base,
    preserved,
    background,
    foreground,
    harmonious
  ) => {
    const bindings = this.host.bindings;
    const baseAllocation = bindings.alloc(256 * 3);
    const mask = bindings.alloc(32);
    const bg = bindings.allocType('GhosttyColorRgb');
    const fg = bindings.allocType('GhosttyColorRgb');
    const output = bindings.alloc(256 * 3);
    try {
      base.forEach((value, index) => {
        bindings.writeColor(baseAllocation.pointer + index * 3, value);
      });
      mask.bytes.fill(0);
      for (const index of preserved) {
        if (index < 0 || index > 255) continue;
        const word = Math.floor(index / 64);
        const bit = BigInt(index % 64);
        const current = mask.view.getBigUint64(word * 8, true);
        mask.view.setBigUint64(word * 8, current | (1n << bit), true);
      }
      bindings.writeColor(bg.pointer, background);
      bindings.writeColor(fg.pointer, foreground);
      bindings.exports.ghostty_color_palette_generate(
        baseAllocation.pointer,
        mask.pointer,
        bg.pointer,
        fg.pointer,
        harmonious,
        output.pointer
      );
      return Array.from({ length: 256 }, (_, index) =>
        bindings.readColor(output.pointer + index * 3)
      );
    } finally {
      baseAllocation.free();
      mask.free();
      bg.free();
      fg.free();
      output.free();
    }
  };

  private rebuildThemeAlpha(): void {
    this.themeAlpha.clear();
    for (const color of this.currentTheme.palette) {
      if (color.a !== 1) this.themeAlpha.set(`${color.r}:${color.g}:${color.b}`, color.a);
    }
  }

  private decorateColor(color: RgbColor, alphaValue?: number): RenderColor;
  private decorateColor(color: RgbColor | null, alphaValue?: number): RenderColor | null;
  private decorateColor(color: RgbColor | null, alphaValue?: number): RenderColor | null {
    if (!color) return null;
    const a = alphaValue ?? this.themeAlpha.get(`${color.r}:${color.g}:${color.b}`) ?? 1;
    return a === 1 ? color : { ...color, a };
  }

  private decorateRows(rows: readonly RenderRow[]): readonly RenderRow[] {
    if (this.themeAlpha.size === 0) return rows;
    return rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({
        ...cell,
        foreground: this.decorateColor(cell.foreground),
        background: this.decorateColor(cell.background),
      })),
    }));
  }

  private decorateFrame(frame: RenderFrame): RenderFrame {
    return {
      ...frame,
      changedRows: this.decorateRows(frame.changedRows),
      colors: {
        ...frame.colors,
        foreground: this.decorateColor(frame.colors.foreground, this.currentTheme.foreground.a),
        background: this.decorateColor(frame.colors.background, this.currentTheme.background.a),
        cursor: this.decorateColor(frame.colors.cursor, this.currentTheme.cursor.a),
        cursorAccent: this.currentTheme.cursorAccent,
        selectionBackground: this.currentTheme.selectionBackground,
        selectionForeground: this.currentTheme.selectionForeground,
        selectionInactiveBackground: this.currentTheme.selectionInactiveBackground,
        palette:
          this.themeAlpha.size === 0
            ? frame.colors.palette
            : frame.colors.palette.map((color) => this.decorateColor(color)),
      },
    };
  }

  private decorateViewport(viewport: ViewportSnapshot): ViewportSnapshot {
    const decorated = this.decorateFrame({
      ...viewport,
      changedRows: viewport.viewportRows,
    });
    return {
      ...decorated,
      viewportRows: decorated.changedRows,
    };
  }

  private setScalarOption(name: string, value: number): void {
    const allocation = this.host.bindings.alloc(4);
    try {
      allocation.view.setUint32(0, Math.max(0, Math.floor(value)), true);
      this.setOption(name, allocation.pointer);
    } finally {
      allocation.free();
    }
  }

  private setOption(name: string, value: number): void {
    this.host.bindings.check(
      this.host.bindings.exports.ghostty_terminal_set(
        this.handle,
        this.host.bindings.abi.value('GhosttyTerminalOption', name),
        value
      ),
      `set terminal option ${name}`
    );
  }

  private scroll(tag: 'TOP' | 'BOTTOM' | 'DELTA', value: number): void {
    this.ensureActive();
    const viewport = this.host.bindings.allocType('GhosttyTerminalScrollViewport');
    try {
      viewport.view.setInt32(
        this.host.bindings.abi.field('GhosttyTerminalScrollViewport', 'tag').offset,
        this.host.bindings.abi.value('GhosttyTerminalScrollViewportTag', tag),
        true
      );
      if (tag === 'DELTA') {
        const unionOffset = this.host.bindings.abi.field(
          'GhosttyTerminalScrollViewport',
          'value'
        ).offset;
        viewport.view.setInt32(
          unionOffset +
            this.host.bindings.abi.field('GhosttyTerminalScrollViewportValue', 'delta').offset,
          value,
          true
        );
      }
      this.host.bindings.exports.ghostty_terminal_scroll_viewport(this.handle, viewport.pointer);
      this.revision += 1;
    } finally {
      viewport.free();
    }
  }

  private terminalString(data: 'TITLE' | 'PWD'): string {
    const output = this.host.bindings.allocType('GhosttyString');
    try {
      const result = this.host.bindings.exports.ghostty_terminal_get(
        this.handle,
        this.host.bindings.abi.value('GhosttyTerminalData', data),
        output.pointer
      );
      if (result === this.host.bindings.abi.value('GhosttyResult', 'NO_VALUE')) return '';
      this.host.bindings.check(result, `read terminal ${data.toLowerCase()}`);
      return this.host.bindings.readStringStruct(output.pointer);
    } finally {
      output.free();
    }
  }

  private syncGeometry(): void {
    const output = this.host.bindings.alloc(4);
    const read = (name: 'COLS' | 'ROWS' | 'WIDTH_PX' | 'HEIGHT_PX', short: boolean) => {
      this.host.bindings.check(
        this.host.bindings.exports.ghostty_terminal_get(
          this.handle,
          this.host.bindings.abi.value('GhosttyTerminalData', name),
          output.pointer
        ),
        `read restored terminal ${name.toLowerCase()}`
      );
      return short ? output.view.getUint16(0, true) : output.view.getUint32(0, true);
    };
    try {
      const cols = read('COLS', true);
      const rows = read('ROWS', true);
      const widthPx = read('WIDTH_PX', false);
      const heightPx = read('HEIGHT_PX', false);
      this._geometry = {
        cols,
        rows,
        widthPx,
        heightPx,
        cellWidthPx: Math.max(1, Math.round(widthPx / cols)),
        cellHeightPx: Math.max(1, Math.round(heightPx / rows)),
      };
    } finally {
      output.free();
    }
  }

  private emitInput(data: Uint8Array, source: 'key' | 'text' | 'paste' | 'focus'): Uint8Array {
    this.ensureActive();
    if (data.length > 0) this.events.emit('input', { data, source });
    return data;
  }

  private flushEffects(): void {
    for (const effect of this.effects.splice(0)) {
      if (effect.type === 'input')
        this.events.emit('input', { data: effect.data, source: 'reply' });
      else if (effect.type === 'bell') this.events.emit('bell', undefined);
      else if (effect.type === 'title') this.events.emit('title', this.terminalString('TITLE'));
      else if (effect.type === 'cwd') this.events.emit('cwd', this.terminalString('PWD'));
      else if (effect.type === 'notification') this.events.emit('notification', effect);
      else if (effect.type === 'progress') this.events.emit('progress', effect);
      else if (effect.type === 'clipboardWrite') this.events.emit('clipboardWrite', effect.request);
      else if (effect.type === 'error') this.events.emit('error', effect.error);
    }
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('CoreTerminal is disposed');
  }
}

const textEncoder = new TextEncoder();

function normalizeClipboardLimit(value: number | undefined): number {
  if (value === undefined) return 32 * 1024 * 1024;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff)
    throw new RangeError('Clipboard maxBytes must be an integer between 1 and 4294967295');
  return value;
}

function normalizeClipboardTtl(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError('Clipboard snapshotTtlMs must be a positive integer');
  return value;
}

function normalizeClipboardContents(
  contents: readonly ClipboardContent[],
  maxBytes: number
): readonly ClipboardContent[] {
  const seen = new Set<string>();
  const normalized: ClipboardContent[] = [];
  let total = 0;
  for (const content of contents) {
    const mime = content.mime.trim().toLowerCase();
    if (!mime) throw new TypeError('Clipboard MIME types cannot be empty');
    if (!(content.data instanceof Uint8Array))
      throw new TypeError(`Clipboard content for ${mime} must be a Uint8Array`);
    if (seen.has(mime)) continue;
    total += content.data.byteLength;
    if (total > maxBytes) throw new RangeError(`Clipboard contents exceed ${maxBytes} bytes`);
    seen.add(mime);
    normalized.push({ mime, data: content.data });
  }
  normalized.sort((left, right) => {
    if (left.mime === 'text/plain') return -1;
    if (right.mime === 'text/plain') return 1;
    return 0;
  });
  return normalized;
}

function isTextMime(mime: string): boolean {
  return mime === 'text/plain' || mime.startsWith('text/');
}

function clipboardLocationValue(bindings: GhosttyBindings, location: ClipboardLocation): number {
  return bindings.abi.value('GhosttyClipboardLocation', location.toUpperCase());
}

function clipboardLocationFromValue(value: number): ClipboardLocation {
  return value === 1 ? 'selection' : value === 2 ? 'primary' : 'standard';
}

function readStringArray(bindings: GhosttyBindings, pointer: number, length: number): string[] {
  if (!pointer || length === 0) return [];
  const size = bindings.abi.size('GhosttyString');
  return Array.from({ length }, (_, index) => bindings.readStringStruct(pointer + index * size));
}

function allocateStrings(
  bindings: GhosttyBindings,
  values: readonly string[]
): { readonly pointer: number; readonly allocations: Allocation[] } {
  if (values.length === 0) return { pointer: 0, allocations: [] };
  const itemSize = bindings.abi.size('GhosttyString');
  const items = bindings.alloc(itemSize * values.length);
  items.bytes.fill(0);
  const allocations: Allocation[] = [items];
  const ptrOffset = bindings.abi.field('GhosttyString', 'ptr').offset;
  const lenOffset = bindings.abi.field('GhosttyString', 'len').offset;
  values.forEach((value, index) => {
    const bytes = textEncoder.encode(value);
    const allocation = bindings.alloc(bytes.byteLength);
    allocation.bytes.set(bytes);
    allocations.push(allocation);
    items.view.setUint32(index * itemSize + ptrOffset, allocation.pointer, true);
    items.view.setUint32(index * itemSize + lenOffset, bytes.byteLength, true);
  });
  return { pointer: items.pointer, allocations };
}

function allocateClipboardContents(
  bindings: GhosttyBindings,
  contents: readonly ClipboardContent[]
): { readonly pointer: number; readonly allocations: Allocation[] } {
  if (contents.length === 0) return { pointer: 0, allocations: [] };
  const itemSize = bindings.abi.size('GhosttyClipboardContent');
  const items = bindings.alloc(itemSize * contents.length);
  items.bytes.fill(0);
  const allocations: Allocation[] = [items];
  const mimeOffset = bindings.abi.field('GhosttyClipboardContent', 'mime').offset;
  const dataOffset = bindings.abi.field('GhosttyClipboardContent', 'data').offset;
  const ptrOffset = bindings.abi.field('GhosttyString', 'ptr').offset;
  const lenOffset = bindings.abi.field('GhosttyString', 'len').offset;
  contents.forEach((content, index) => {
    const base = index * itemSize;
    const mime = textEncoder.encode(content.mime);
    const mimeAllocation = bindings.alloc(mime.byteLength);
    mimeAllocation.bytes.set(mime);
    allocations.push(mimeAllocation);
    items.view.setUint32(base + mimeOffset + ptrOffset, mimeAllocation.pointer, true);
    items.view.setUint32(base + mimeOffset + lenOffset, mime.byteLength, true);
    if (content.data.byteLength > 0) {
      const dataAllocation = bindings.alloc(content.data.byteLength);
      dataAllocation.bytes.set(content.data);
      allocations.push(dataAllocation);
      items.view.setUint32(base + dataOffset + ptrOffset, dataAllocation.pointer, true);
      items.view.setUint32(base + dataOffset + lenOffset, content.data.byteLength, true);
    }
  });
  return { pointer: items.pointer, allocations };
}

function callTable(bindings: GhosttyBindings, index: number, ...args: number[]): void {
  const callback = bindings.exports.__indirect_function_table.get(index);
  if (typeof callback !== 'function') throw new Error('Ghostty callback reply is unavailable');
  (callback as (...values: number[]) => void)(...args);
}

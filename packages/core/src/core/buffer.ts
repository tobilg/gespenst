import {
  XTERM_CELL_WORDS,
  type XtermCompatibilityRow,
  type XtermCompatibilityString,
} from '../internal/xterm-compatibility.js';
import { type CellBitFields, cellBitFields, cellCodepoint, packedBits } from './abi.js';
import type { Allocation, GhosttyBindings } from './bindings.js';
import type {
  CellColor,
  CellStyle,
  CellWidth,
  RenderCell,
  RenderColor,
  ResolvedTerminalTheme,
  SemanticContent,
  TerminalBufferRange,
  TerminalBufferRow,
  TerminalBufferSnapshot,
  TerminalBufferState,
  TerminalCursorAttributes,
  TerminalModeState,
} from './types.js';

const DEFAULT_STYLE: CellStyle = {
  bold: false,
  italic: false,
  faint: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: 0,
};

interface CellStyling {
  readonly style: CellStyle;
  readonly foreground: RenderColor | null;
  readonly background: RenderColor | null;
  readonly foregroundSource: CellColor;
  readonly backgroundSource: CellColor;
  readonly underlineSource: CellColor;
}

const DEFAULT_COLOR: CellColor = { mode: 'default' };
const DEFAULT_STYLING: CellStyling = {
  style: DEFAULT_STYLE,
  foreground: null,
  background: null,
  foregroundSource: DEFAULT_COLOR,
  backgroundSource: DEFAULT_COLOR,
  underlineSource: DEFAULT_COLOR,
};

// Indexed by the raw `GhosttyCellWide` and `GhosttyCellSemanticContent` values.
const CELL_WIDTHS: readonly CellWidth[] = ['narrow', 'wide', 'spacer-tail', 'spacer-head'];
const SEMANTIC_CONTENT: readonly SemanticContent[] = ['output', 'input', 'prompt'];

const COMPATIBILITY_MODES = [
  [1, false],
  [66, false],
  [2004, false],
  [4, true],
  [1003, false],
  [1002, false],
  [1000, false],
  [9, false],
  [6, false],
  [45, false],
  [1004, false],
  [2026, false],
  [7, false],
] as const;

/** Reads paged rows directly from Ghostty without introducing another VT parser. */
export class BufferReader {
  private readonly bindings: GhosttyBindings;
  private readonly scalar: Allocation;
  private readonly point: Allocation;
  private readonly gridRef: Allocation;
  private readonly cell: Allocation;
  private readonly row: Allocation;
  private readonly style: Allocation;
  private readonly scrollbar: Allocation;
  private readonly graphemeLength: Allocation;
  private graphemes: Allocation;
  private readonly mode: Allocation;
  private readonly cursorStyle: Allocation;
  private readonly terminalScalars: Allocation;
  private readonly terminalMultiKeys: Allocation;
  private readonly terminalMultiValues: Allocation;
  private readonly terminalMultiWritten: Allocation;
  private readonly modeBatch: Allocation;
  private readonly modeSize: number;
  private readonly hyperlinkLength: Allocation;
  private hyperlinkBytes: Allocation;
  private readonly cellBits: CellBitFields;
  private readonly rowIdentityOffsets: Readonly<{
    pointTag: number;
    pointY: number;
    screenTag: number;
    node: number;
    localY: number;
    noValue: number;
    success: number;
    coordinateY: number;
    x: number;
  }>;

  constructor(bindings: GhosttyBindings) {
    this.bindings = bindings;
    this.cellBits = cellBitFields(bindings.abi);
    const abi = bindings.abi;
    this.rowIdentityOffsets = {
      pointTag: abi.field('GhosttyPoint', 'tag').offset,
      pointY:
        abi.field('GhosttyPoint', 'value').offset + abi.field('GhosttyPointCoordinate', 'y').offset,
      screenTag: abi.value('GhosttyPointTag', 'SCREEN'),
      node: abi.field('GhosttyGridRef', 'node').offset,
      localY: abi.field('GhosttyGridRef', 'y').offset,
      noValue: abi.value('GhosttyResult', 'NO_VALUE'),
      success: abi.value('GhosttyResult', 'SUCCESS'),
      coordinateY: abi.field('GhosttyPointCoordinate', 'y').offset,
      x: abi.field('GhosttyGridRef', 'x').offset,
    };
    this.scalar = bindings.alloc(8);
    this.point = bindings.allocType('GhosttyPoint');
    this.gridRef = bindings.allocType('GhosttyGridRef', true);
    this.cell = bindings.alloc(8);
    this.row = bindings.alloc(8);
    this.style = bindings.allocType('GhosttyStyle', true);
    this.scrollbar = bindings.allocType('GhosttyTerminalScrollbar');
    this.graphemeLength = bindings.alloc(4);
    this.graphemes = bindings.alloc(16 * 4);
    this.mode = bindings.allocType('GhosttyTerminalModeConfig', true);
    this.cursorStyle = bindings.allocType('GhosttyStyle', true);
    this.terminalScalars = bindings.alloc(8);
    this.terminalMultiKeys = bindings.alloc((5 + COMPATIBILITY_MODES.length) * 4);
    this.terminalMultiValues = bindings.alloc((5 + COMPATIBILITY_MODES.length) * 4);
    this.terminalMultiWritten = bindings.alloc(4);
    this.modeSize = bindings.abi.size('GhosttyTerminalModeConfig');
    this.modeBatch = bindings.alloc(this.modeSize * COMPATIBILITY_MODES.length);
    this.initializeTerminalMultiQuery();
    this.hyperlinkLength = bindings.alloc(4);
    this.hyperlinkBytes = bindings.alloc(64);
  }

  state(terminal: number, revision: number): TerminalBufferState {
    const bulk = this.readTerminalStateBulk(terminal);
    const screenValue = bulk
      ? this.terminalScalars.view.getInt32(0, true)
      : this.getInt(terminal, 'ACTIVE_SCREEN', 4);
    if (!bulk)
      this.bindings.check(
        this.bindings.exports.ghostty_terminal_get(
          terminal,
          this.bindings.abi.value('GhosttyTerminalData', 'SCROLLBAR'),
          this.scrollbar.pointer
        ),
        'read terminal scrollbar'
      );
    const total = Number(this.scrollbar.view.getBigUint64(0, true));
    const offset = Number(this.scrollbar.view.getBigUint64(8, true));
    const length = Number(this.scrollbar.view.getBigUint64(16, true));
    return {
      screen:
        screenValue === this.bindings.abi.value('GhosttyTerminalScreen', 'ALTERNATE')
          ? 'alternate'
          : 'normal',
      totalRows: total,
      scrollbackRows: Math.max(0, total - length),
      viewportY: Math.max(0, Math.min(offset, Math.max(0, total - length))),
      viewportLength: length,
      cursorX: bulk
        ? this.terminalScalars.view.getUint16(4, true)
        : this.getInt(terminal, 'CURSOR_X', 2),
      cursorY: bulk
        ? this.terminalScalars.view.getUint16(6, true)
        : this.getInt(terminal, 'CURSOR_Y', 2),
      modes: bulk ? this.readModesBulk() : this.readModes(terminal),
      cursorAttributes: bulk
        ? this.cursorAttributesFromStyle()
        : this.readCursorAttributes(terminal),
      revision,
    };
  }

  read(
    terminal: number,
    revision: number,
    theme: ResolvedTerminalTheme,
    range?: TerminalBufferRange
  ): TerminalBufferSnapshot {
    const state = this.state(terminal, revision);
    const requestedStart = range?.start ?? state.viewportY;
    const requestedEnd = range?.end ?? state.viewportY + state.viewportLength;
    const start = clamp(Math.floor(requestedStart), 0, state.totalRows);
    const end = clamp(Math.floor(requestedEnd), start, state.totalRows);
    const rows: TerminalBufferRow[] = [];
    // Style ids are local to a page and stable while the terminal is not written to.
    const styles = new Map<number, CellStyling>();
    for (let index = start; index < end; index += 1) {
      const row = this.readRow(terminal, index, theme, styles);
      if (row) rows.push(row);
    }
    return { state, rows };
  }

  /**
   * Points a tracked reference at a retained row, creating the reference when `tracked` is 0.
   * Ghostty moves it as rows scroll or are pruned. Returns 0 when the row does not exist.
   */
  trackRow(terminal: number, index: number, tracked: number): number {
    const offsets = this.rowIdentityOffsets;
    let memory = this.bindings.memoryView;
    new Uint8Array(memory.buffer, this.point.pointer, this.point.length).fill(0);
    memory.setInt32(this.point.pointer + offsets.pointTag, offsets.screenTag, true);
    memory.setUint32(this.point.pointer + offsets.pointY, index, true);
    const exports = this.bindings.exports;
    if (tracked !== 0) {
      const result = exports.ghostty_tracked_grid_ref_set(tracked, terminal, this.point.pointer);
      if (result === offsets.success) return tracked;
      exports.ghostty_tracked_grid_ref_free(tracked);
      return 0;
    }
    const result = exports.ghostty_terminal_grid_ref_track(
      terminal,
      this.point.pointer,
      this.scalar.pointer
    );
    if (result !== offsets.success) return 0;
    memory = this.bindings.memoryView;
    return memory.getUint32(this.scalar.pointer, true);
  }

  /** The current row index of a tracked reference, or -1 once Ghostty discarded its row. */
  trackedRow(tracked: number): number {
    if (tracked === 0) return -1;
    const offsets = this.rowIdentityOffsets;
    const result = this.bindings.exports.ghostty_tracked_grid_ref_point(
      tracked,
      offsets.screenTag,
      this.scalar.pointer
    );
    if (result !== offsets.success) return -1;
    return this.bindings.memoryView.getUint32(this.scalar.pointer + offsets.coordinateY, true);
  }

  /** Frees a reference created by {@link trackRow}. */
  releaseTrackedRow(tracked: number): void {
    if (tracked !== 0) this.bindings.exports.ghostty_tracked_grid_ref_free(tracked);
  }

  /** Reads an explicit retained-buffer range directly into the xterm packed cell format. */
  compatibilityRows(
    terminal: number,
    start: number,
    end: number
  ): readonly XtermCompatibilityRow[] {
    const rows: XtermCompatibilityRow[] = [];
    const cols = this.getInt(terminal, 'COLS', 2);
    const bits = this.cellBits;
    // Style ids are local to a page and stable while the terminal is not written to.
    const styles = new Map<number, readonly [number, number, number]>();
    for (let index = start; index < end; index += 1) {
      if (!this.selectRowIdentity(terminal, index)) continue;
      this.bindings.check(
        this.bindings.exports.ghostty_grid_ref_row(this.gridRef.pointer, this.row.pointer),
        `read xterm terminal row ${index}`
      );
      const rawRow = this.row.view.getBigUint64(0, true);
      const styleScope = this.selectedNode() * 2 ** bits.styleId.width;
      const cells = new Uint32Array(cols * XTERM_CELL_WORDS);
      const strings: XtermCompatibilityString[] = [];
      const hyperlinks: XtermCompatibilityString[] = [];
      let retainedCells = 0;
      for (let x = 0; x < cols; x += 1) {
        const [low, high] = this.readCell(index, x);
        const text = this.cellText(low, high);
        const firstCodepoint = text.codePointAt(0) ?? 0;
        const combined = text.length > (firstCodepoint > 0xffff ? 2 : firstCodepoint > 0 ? 1 : 0);
        // The raw wide value matches xterm's width encoding: narrow, wide, tail, head.
        const width = packedBits(low, high, bits.wide);
        const styleId = packedBits(low, high, bits.styleId);
        let underline = 0;
        let foreground = 0;
        let background = 0;
        if (styleId !== 0) {
          let words = styles.get(styleScope + styleId);
          if (!words) {
            this.readSelectedStyle(index, x);
            const field = (name: string) => this.bindings.abi.field('GhosttyStyle', name).offset;
            const view = this.style.view;
            words = [
              view.getInt32(field('underline'), true),
              compatibilityColorWord(this.readStyleColorSource('fg_color')) |
                (view.getUint8(field('bold')) !== 0 ? 1 << 26 : 0) |
                (view.getUint8(field('italic')) !== 0 ? 1 << 27 : 0) |
                (view.getUint8(field('faint')) !== 0 ? 1 << 28 : 0),
              compatibilityColorWord(this.readStyleColorSource('bg_color')) |
                (view.getUint8(field('blink')) !== 0 ? 1 << 26 : 0) |
                (view.getUint8(field('inverse')) !== 0 ? 1 << 27 : 0) |
                (view.getUint8(field('invisible')) !== 0 ? 1 << 28 : 0) |
                (view.getUint8(field('strikethrough')) !== 0 ? 1 << 29 : 0) |
                (view.getUint8(field('overline')) !== 0 ? 1 << 30 : 0),
            ];
            styles.set(styleScope + styleId, words);
          }
          [underline, foreground, background] = words;
        }
        const hyperlink = packedBits(low, high, bits.hyperlink) === 1;
        const offset = x * XTERM_CELL_WORDS;
        cells[offset] =
          ((combined ? lastCompatibilityCodepoint(text) : firstCodepoint) & 0x1fffff) |
          (width << 21) |
          (combined ? 1 << 23 : 0) |
          ((underline & 0x7) << 24) |
          (1 << 27);
        cells[offset + 1] = foreground;
        cells[offset + 2] = background;
        if (combined) strings.push([x, text]);
        if (hyperlink) {
          const uri = this.readHyperlinkUri();
          if (uri) hyperlinks.push([x, uri]);
        }
        if (
          text ||
          width !== 0 ||
          underline !== 0 ||
          foreground !== 0 ||
          background !== 0 ||
          hyperlink
        )
          retainedCells = x + 1;
      }
      rows.push({
        index,
        cells: retainedCells === cols ? cells : cells.slice(0, retainedCells * XTERM_CELL_WORDS),
        strings,
        hyperlinks,
        wrapped: this.rowFlag(rawRow, 'WRAP'),
        wrapContinuation: this.rowFlag(rawRow, 'WRAP_CONTINUATION'),
      });
    }
    return rows;
  }

  dispose(): void {
    for (const allocation of [
      this.scalar,
      this.point,
      this.gridRef,
      this.cell,
      this.row,
      this.style,
      this.scrollbar,
      this.graphemeLength,
      this.graphemes,
      this.mode,
      this.cursorStyle,
      this.terminalScalars,
      this.terminalMultiKeys,
      this.terminalMultiValues,
      this.terminalMultiWritten,
      this.modeBatch,
      this.hyperlinkLength,
      this.hyperlinkBytes,
    ])
      allocation.free();
  }

  private readRow(
    terminal: number,
    index: number,
    theme: ResolvedTerminalTheme,
    styles: Map<number, CellStyling>
  ): TerminalBufferRow | null {
    const bindings = this.bindings;
    const abi = bindings.abi;
    const pointValue = abi.field('GhosttyPoint', 'value').offset;
    this.point.bytes.fill(0);
    this.point.view.setInt32(
      abi.field('GhosttyPoint', 'tag').offset,
      abi.value('GhosttyPointTag', 'SCREEN'),
      true
    );
    this.point.view.setUint32(
      pointValue + abi.field('GhosttyPointCoordinate', 'y').offset,
      index,
      true
    );
    this.gridRef.bytes.fill(0);
    this.gridRef.view.setUint32(0, this.gridRef.length, true);
    const result = bindings.exports.ghostty_terminal_grid_ref(
      terminal,
      this.point.pointer,
      this.gridRef.pointer
    );
    if (result === abi.value('GhosttyResult', 'NO_VALUE')) return null;
    bindings.check(result, `read terminal buffer row ${index}`);
    bindings.check(
      bindings.exports.ghostty_grid_ref_row(this.gridRef.pointer, this.row.pointer),
      `read terminal row handle ${index}`
    );
    const row = this.row.view.getBigUint64(0, true);
    const node = this.gridRef.view.getUint32(abi.field('GhosttyGridRef', 'node').offset, true);
    const localY = this.gridRef.view.getUint16(abi.field('GhosttyGridRef', 'y').offset, true);
    const cells: RenderCell[] = [];
    const cols = this.getInt(terminal, 'COLS', 2);
    const bits = this.cellBits;
    const styleScope = node * 2 ** bits.styleId.width;
    for (let x = 0; x < cols; x += 1) {
      const [low, high] = this.readCell(index, x);
      const styleId = packedBits(low, high, bits.styleId);
      let styling = DEFAULT_STYLING;
      if (styleId !== 0) {
        const cached = styles.get(styleScope + styleId);
        if (cached) styling = cached;
        else {
          this.readSelectedStyle(index, x);
          const foregroundSource = this.readStyleColorSource('fg_color');
          const backgroundSource = this.readStyleColorSource('bg_color');
          styling = {
            style: this.readStyle(),
            foreground: resolveStyleColor(foregroundSource, theme),
            background: resolveStyleColor(backgroundSource, theme),
            foregroundSource,
            backgroundSource,
            underlineSource: this.readStyleColorSource('underline_color'),
          };
          styles.set(styleScope + styleId, styling);
        }
      }
      const hyperlink = packedBits(low, high, bits.hyperlink) === 1;
      cells.push({
        x,
        text: this.cellText(low, high),
        width: CELL_WIDTHS[packedBits(low, high, bits.wide)] ?? 'narrow',
        ...styling,
        hyperlink,
        hyperlinkUri: hyperlink ? this.readHyperlinkUri() : null,
        semanticContent: SEMANTIC_CONTENT[packedBits(low, high, bits.semanticContent)] ?? 'unknown',
      });
    }
    return {
      index,
      id: `${node}:${localY}`,
      text: rowText(cells),
      cells,
      wrapped: this.rowFlag(row, 'WRAP'),
      wrapContinuation: this.rowFlag(row, 'WRAP_CONTINUATION'),
      selection: null,
    };
  }

  /** Reads the raw cell at column `x` of the selected row as its low and high 32-bit words. */
  private readCell(index: number, x: number): readonly [low: number, high: number] {
    this.bindings.memoryView.setUint16(this.gridRef.pointer + this.rowIdentityOffsets.x, x, true);
    this.bindings.check(
      this.bindings.exports.ghostty_grid_ref_cell(this.gridRef.pointer, this.cell.pointer),
      `read terminal cell ${index}:${x}`
    );
    const view = this.bindings.memoryView;
    return [view.getUint32(this.cell.pointer, true), view.getUint32(this.cell.pointer + 4, true)];
  }

  /** Decodes a raw cell's text; only multi-codepoint graphemes need another WASM call. */
  private cellText(low: number, high: number): string {
    const bits = this.cellBits;
    const tag = packedBits(low, high, bits.contentTag);
    if (tag !== bits.tagCodepoint && tag !== bits.tagGrapheme) return '';
    const codepoint = cellCodepoint(low, high, bits);
    if (codepoint === 0) return '';
    return tag === bits.tagGrapheme ? this.readGrapheme() : String.fromCodePoint(codepoint);
  }

  /** Reads the style of the cell selected by {@link readCell} into the style buffer. */
  private readSelectedStyle(index: number, x: number): void {
    this.style.bytes.fill(0);
    this.style.view.setUint32(0, this.style.length, true);
    this.bindings.check(
      this.bindings.exports.ghostty_grid_ref_style(this.gridRef.pointer, this.style.pointer),
      `read terminal cell style ${index}:${x}`
    );
  }

  /** Page node of the row last selected by {@link selectRowIdentity}. */
  private selectedNode(): number {
    return this.gridRef.view.getUint32(
      this.bindings.abi.field('GhosttyGridRef', 'node').offset,
      true
    );
  }

  private selectRowIdentity(
    terminal: number,
    index: number
  ): { readonly node: number; readonly localY: number } | null {
    const offsets = this.rowIdentityOffsets;
    let memory = this.bindings.memoryView;
    new Uint8Array(memory.buffer, this.point.pointer, this.point.length).fill(0);
    memory.setInt32(this.point.pointer + offsets.pointTag, offsets.screenTag, true);
    memory.setUint32(this.point.pointer + offsets.pointY, index, true);
    new Uint8Array(memory.buffer, this.gridRef.pointer, this.gridRef.length).fill(0);
    memory.setUint32(this.gridRef.pointer, this.gridRef.length, true);
    const result = this.bindings.exports.ghostty_terminal_grid_ref(
      terminal,
      this.point.pointer,
      this.gridRef.pointer
    );
    if (result === offsets.noValue) return null;
    this.bindings.check(result, `read terminal buffer row identity ${index}`);
    memory = this.bindings.memoryView;
    const node = memory.getUint32(this.gridRef.pointer + offsets.node, true);
    const localY = memory.getUint16(this.gridRef.pointer + offsets.localY, true);
    return { node, localY };
  }

  private getInt(terminal: number, name: string, size: 2 | 4): number {
    this.bindings.check(
      this.bindings.exports.ghostty_terminal_get(
        terminal,
        this.bindings.abi.value('GhosttyTerminalData', name),
        this.scalar.pointer
      ),
      `read terminal ${name.toLowerCase()}`
    );
    return size === 2 ? this.scalar.view.getUint16(0, true) : this.scalar.view.getInt32(0, true);
  }

  private rowFlag(row: bigint, name: string): boolean {
    this.bindings.check(
      this.bindings.exports.ghostty_row_get(
        row,
        this.bindings.abi.value('GhosttyRowData', name),
        this.scalar.pointer
      ),
      `read row ${name.toLowerCase()}`
    );
    return this.scalar.view.getUint8(0) !== 0;
  }

  private readGrapheme(): string {
    const outOfSpace = this.bindings.abi.value('GhosttyResult', 'OUT_OF_SPACE');
    for (;;) {
      this.graphemeLength.view.setUint32(0, 0, true);
      const result = this.bindings.exports.ghostty_grid_ref_graphemes(
        this.gridRef.pointer,
        this.graphemes.pointer,
        this.graphemes.length / 4,
        this.graphemeLength.pointer
      );
      const length = this.graphemeLength.view.getUint32(0, true);
      if (result === 0) {
        const points = new Uint32Array(
          this.bindings.exports.memory.buffer,
          this.graphemes.pointer,
          length
        );
        return String.fromCodePoint(...points);
      }
      if (result !== outOfSpace) this.bindings.check(result, 'read cell grapheme');
      this.graphemes.free();
      this.graphemes = this.bindings.alloc(Math.max(length * 4, 32));
    }
  }

  private readStyle(): CellStyle {
    const field = (name: string) => this.bindings.abi.field('GhosttyStyle', name).offset;
    return {
      bold: this.style.view.getUint8(field('bold')) !== 0,
      italic: this.style.view.getUint8(field('italic')) !== 0,
      faint: this.style.view.getUint8(field('faint')) !== 0,
      blink: this.style.view.getUint8(field('blink')) !== 0,
      inverse: this.style.view.getUint8(field('inverse')) !== 0,
      invisible: this.style.view.getUint8(field('invisible')) !== 0,
      strikethrough: this.style.view.getUint8(field('strikethrough')) !== 0,
      overline: this.style.view.getUint8(field('overline')) !== 0,
      underline: this.style.view.getInt32(field('underline'), true),
    };
  }

  private readStyleColorSource(
    fieldName: 'fg_color' | 'bg_color' | 'underline_color',
    source = this.style
  ): CellColor {
    const abi = this.bindings.abi;
    const base = abi.field('GhosttyStyle', fieldName).offset;
    const tag = source.view.getInt32(base + abi.field('GhosttyStyleColor', 'tag').offset, true);
    const value = base + abi.field('GhosttyStyleColor', 'value').offset;
    if (tag === abi.value('GhosttyStyleColorTag', 'PALETTE')) {
      return { mode: 'palette', value: source.view.getUint8(value) };
    }
    if (tag === abi.value('GhosttyStyleColorTag', 'RGB')) {
      return {
        mode: 'rgb',
        value: {
          r: source.view.getUint8(value),
          g: source.view.getUint8(value + 1),
          b: source.view.getUint8(value + 2),
        },
      };
    }
    return { mode: 'default' };
  }

  private readHyperlinkUri(): string | null {
    const outOfSpace = this.bindings.abi.value('GhosttyResult', 'OUT_OF_SPACE');
    for (;;) {
      this.hyperlinkLength.view.setUint32(0, 0, true);
      const result = this.bindings.exports.ghostty_grid_ref_hyperlink_uri(
        this.gridRef.pointer,
        this.hyperlinkBytes.pointer,
        this.hyperlinkBytes.length,
        this.hyperlinkLength.pointer
      );
      const length = this.hyperlinkLength.view.getUint32(0, true);
      if (result === 0)
        return length === 0 ? null : this.bindings.readString(this.hyperlinkBytes.pointer, length);
      if (result !== outOfSpace) this.bindings.check(result, 'read cell hyperlink URI');
      this.hyperlinkBytes.free();
      this.hyperlinkBytes = this.bindings.alloc(Math.max(length, 64));
    }
  }

  private readModes(terminal: number): TerminalModeState {
    const mode = (value: number, ansi = false) => this.readMode(terminal, value, ansi);
    const mouseTrackingMode: TerminalModeState['mouseTrackingMode'] = mode(1003)
      ? 'any'
      : mode(1002)
        ? 'drag'
        : mode(1000)
          ? 'vt200'
          : mode(9)
            ? 'x10'
            : 'none';
    return {
      applicationCursorKeysMode: mode(1),
      applicationKeypadMode: mode(66),
      bracketedPasteMode: mode(2004),
      insertMode: mode(4, true),
      mouseTrackingMode,
      originMode: mode(6),
      reverseWraparoundMode: mode(45),
      sendFocusMode: mode(1004),
      synchronizedOutputMode: mode(2026),
      wraparoundMode: mode(7),
    };
  }

  private readModesBulk(): TerminalModeState {
    const enabled = (index: number) =>
      this.modeBatch.view.getUint8(
        index * this.modeSize + this.bindings.abi.field('GhosttyTerminalModeConfig', 'value').offset
      ) !== 0;
    const mouseTrackingMode: TerminalModeState['mouseTrackingMode'] = enabled(4)
      ? 'any'
      : enabled(5)
        ? 'drag'
        : enabled(6)
          ? 'vt200'
          : enabled(7)
            ? 'x10'
            : 'none';
    return {
      applicationCursorKeysMode: enabled(0),
      applicationKeypadMode: enabled(1),
      bracketedPasteMode: enabled(2),
      insertMode: enabled(3),
      mouseTrackingMode,
      originMode: enabled(8),
      reverseWraparoundMode: enabled(9),
      sendFocusMode: enabled(10),
      synchronizedOutputMode: enabled(11),
      wraparoundMode: enabled(12),
    };
  }

  private readMode(terminal: number, value: number, ansi: boolean): boolean {
    const abi = this.bindings.abi;
    this.mode.bytes.fill(0);
    this.mode.view.setUint16(
      abi.field('GhosttyTerminalModeConfig', 'mode').offset,
      (value & 0x7fff) | (ansi ? 0x8000 : 0),
      true
    );
    this.bindings.check(
      this.bindings.exports.ghostty_terminal_get(
        terminal,
        abi.value('GhosttyTerminalData', 'MODE'),
        this.mode.pointer
      ),
      `read terminal mode ${value}`
    );
    return this.mode.view.getUint8(abi.field('GhosttyTerminalModeConfig', 'value').offset) !== 0;
  }

  private readCursorAttributes(terminal: number): TerminalCursorAttributes {
    this.cursorStyle.bytes.fill(0);
    this.cursorStyle.view.setUint32(0, this.cursorStyle.length, true);
    this.bindings.check(
      this.bindings.exports.ghostty_terminal_get(
        terminal,
        this.bindings.abi.value('GhosttyTerminalData', 'CURSOR_STYLE'),
        this.cursorStyle.pointer
      ),
      'read terminal cursor attributes'
    );
    return this.cursorAttributesFromStyle();
  }

  private cursorAttributesFromStyle(): TerminalCursorAttributes {
    const field = (name: string) => this.bindings.abi.field('GhosttyStyle', name).offset;
    return {
      style: {
        bold: this.cursorStyle.view.getUint8(field('bold')) !== 0,
        italic: this.cursorStyle.view.getUint8(field('italic')) !== 0,
        faint: this.cursorStyle.view.getUint8(field('faint')) !== 0,
        blink: this.cursorStyle.view.getUint8(field('blink')) !== 0,
        inverse: this.cursorStyle.view.getUint8(field('inverse')) !== 0,
        invisible: this.cursorStyle.view.getUint8(field('invisible')) !== 0,
        strikethrough: this.cursorStyle.view.getUint8(field('strikethrough')) !== 0,
        overline: this.cursorStyle.view.getUint8(field('overline')) !== 0,
        underline: this.cursorStyle.view.getInt32(field('underline'), true),
      },
      foreground: this.readStyleColorSource('fg_color', this.cursorStyle),
      background: this.readStyleColorSource('bg_color', this.cursorStyle),
      underline: this.readStyleColorSource('underline_color', this.cursorStyle),
    };
  }

  private initializeTerminalMultiQuery(): void {
    const abi = this.bindings.abi;
    const keys = [
      ['ACTIVE_SCREEN', this.terminalScalars.pointer],
      ['SCROLLBAR', this.scrollbar.pointer],
      ['CURSOR_X', this.terminalScalars.pointer + 4],
      ['CURSOR_Y', this.terminalScalars.pointer + 6],
      ['CURSOR_STYLE', this.cursorStyle.pointer],
    ] as const;
    for (let index = 0; index < keys.length; index += 1) {
      const entry = keys[index];
      if (!entry) continue;
      this.terminalMultiKeys.view.setInt32(
        index * 4,
        abi.value('GhosttyTerminalData', entry[0]),
        true
      );
      this.terminalMultiValues.view.setUint32(index * 4, entry[1], true);
    }
    const modeField = abi.field('GhosttyTerminalModeConfig', 'mode').offset;
    for (let index = 0; index < COMPATIBILITY_MODES.length; index += 1) {
      const entry = COMPATIBILITY_MODES[index];
      if (!entry) continue;
      const queryIndex = keys.length + index;
      const pointer = this.modeBatch.pointer + index * this.modeSize;
      this.modeBatch.view.setUint16(
        index * this.modeSize + modeField,
        (entry[0] & 0x7fff) | (entry[1] ? 0x8000 : 0),
        true
      );
      this.terminalMultiKeys.view.setInt32(
        queryIndex * 4,
        abi.value('GhosttyTerminalData', 'MODE'),
        true
      );
      this.terminalMultiValues.view.setUint32(queryIndex * 4, pointer, true);
    }
  }

  private readTerminalStateBulk(terminal: number): boolean {
    const candidate = this.bindings.exports.ghostty_terminal_get_multi;
    if (typeof candidate !== 'function') return false;
    this.scrollbar.bytes.fill(0);
    this.scrollbar.view.setUint32(0, this.scrollbar.length, true);
    this.cursorStyle.bytes.fill(0);
    this.cursorStyle.view.setUint32(0, this.cursorStyle.length, true);
    this.terminalMultiWritten.view.setUint32(0, 0, true);
    const result = candidate(
      terminal,
      5 + COMPATIBILITY_MODES.length,
      this.terminalMultiKeys.pointer,
      this.terminalMultiValues.pointer,
      this.terminalMultiWritten.pointer
    ) as number;
    this.bindings.check(result, 'read terminal compatibility state');
    return true;
  }
}

function resolveStyleColor(color: CellColor, theme: ResolvedTerminalTheme): RenderColor | null {
  if (color.mode === 'palette') return theme.palette[color.value] ?? null;
  if (color.mode === 'rgb') return color.value;
  return null;
}

function rowText(cells: readonly RenderCell[]): string {
  let lastTextCell = -1;
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index]?.text) {
      lastTextCell = index;
      break;
    }
  }
  if (lastTextCell === -1) return '';

  let text = '';
  for (let index = 0; index <= lastTextCell; index += 1) {
    const cell = cells[index];
    if (!cell || cell.width === 'spacer-head' || cell.width === 'spacer-tail') continue;
    text += cell.text || ' ';
  }
  return text;
}

function compatibilityColorWord(source: CellColor): number {
  if (source.mode === 'palette') return source.value | (source.value < 16 ? 1 << 24 : 2 << 24);
  if (source.mode === 'rgb')
    return (source.value.r << 16) | (source.value.g << 8) | source.value.b | (3 << 24);
  return 0;
}

function lastCompatibilityCodepoint(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; ) {
    result = value.codePointAt(index) ?? 0;
    index += result > 0xffff ? 2 : 1;
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

import type { CellColor, RenderCell, RgbColor, TerminalBufferState } from '@gespenst/core';
import type { IBuffer, IBufferCell, IBufferLine, IBufferNamespace } from '@xterm/xterm';
import { EventEmitter } from './events';

const CELL_WORDS = 3;
const CONTENT_CODEPOINT_MASK = 0x1fffff;
const CONTENT_WIDTH_SHIFT = 21;
const CONTENT_COMBINED = 1 << 23;
const CONTENT_UNDERLINE_SHIFT = 24;
const CONTENT_PRESENT = 1 << 27;
const COLOR_VALUE_MASK = 0xffffff;
const COLOR_MODE_MASK = 0x3000000;

export type PackedBufferString = readonly [column: number, value: string];

export interface PackedBufferRow {
  readonly index: number;
  readonly cells: Uint32Array;
  readonly strings: readonly PackedBufferString[];
  readonly hyperlinks: readonly PackedBufferString[];
  readonly wrapped: boolean;
  readonly wrapContinuation: boolean;
}

function colorNumber(color: RgbColor | null): number {
  return color ? (color.r << 16) | (color.g << 8) | color.b : 0;
}

function colorMode(color: CellColor | undefined, resolved: RgbColor | null): number {
  if (color?.mode === 'palette') return color.value < 16 ? 0x1000000 : 0x2000000;
  if (color?.mode === 'rgb' || (!color && resolved)) return 0x3000000;
  return 0;
}

function encodedColor(color: CellColor | undefined, resolved: RgbColor | null): number {
  if (color?.mode === 'palette') return color.value;
  if (color?.mode === 'rgb') return colorNumber(color.value);
  return colorNumber(resolved);
}

export class BufferCell implements IBufferCell {
  private content = 0;
  private foreground = 0;
  private background = 0;
  private chars = '';

  load(cell: RenderCell | null): this {
    const packed = cell ? packCell(cell) : null;
    this.content = packed?.content ?? 0;
    this.foreground = packed?.foreground ?? 0;
    this.background = packed?.background ?? 0;
    this.chars = packed?.chars ?? '';
    return this;
  }

  loadPacked(row: PackedBufferRow, column: number): this {
    const offset = column * CELL_WORDS;
    this.content = offset < row.cells.length ? (row.cells[offset] ?? 0) : CONTENT_PRESENT;
    this.foreground = row.cells[offset + 1] ?? 0;
    this.background = row.cells[offset + 2] ?? 0;
    this.chars =
      (this.content & CONTENT_COMBINED) !== 0
        ? (findSparseValue(row.strings, column) ?? '')
        : codepointText(this.content & CONTENT_CODEPOINT_MASK);
    return this;
  }

  getWidth(): number {
    const width = (this.content >>> CONTENT_WIDTH_SHIFT) & 0x3;
    if ((this.content & CONTENT_PRESENT) === 0 || width === 2 || width === 3) return 0;
    return width === 1 ? 2 : 1;
  }
  getChars(): string {
    return this.chars;
  }
  getCode(): number {
    const chars = [...this.chars];
    return chars.at(-1)?.codePointAt(0) ?? 0;
  }
  getFgColorMode(): number {
    return this.foreground & COLOR_MODE_MASK;
  }
  getBgColorMode(): number {
    return this.background & COLOR_MODE_MASK;
  }
  getFgColor(): number {
    return this.foreground & COLOR_VALUE_MASK;
  }
  getBgColor(): number {
    return this.background & COLOR_VALUE_MASK;
  }
  isBold(): number {
    return (this.foreground >>> 26) & 1;
  }
  isItalic(): number {
    return (this.foreground >>> 27) & 1;
  }
  isDim(): number {
    return (this.foreground >>> 28) & 1;
  }
  isUnderline(): number {
    return (this.content >>> CONTENT_UNDERLINE_SHIFT) & 0x7;
  }
  isBlink(): number {
    return (this.background >>> 26) & 1;
  }
  isInverse(): number {
    return (this.background >>> 27) & 1;
  }
  isInvisible(): number {
    return (this.background >>> 28) & 1;
  }
  isStrikethrough(): number {
    return (this.background >>> 29) & 1;
  }
  isOverline(): number {
    return (this.background >>> 30) & 1;
  }
  isFgRGB(): boolean {
    return this.getFgColorMode() === 0x3000000;
  }
  isBgRGB(): boolean {
    return this.getBgColorMode() === 0x3000000;
  }
  isFgPalette(): boolean {
    const mode = this.getFgColorMode();
    return mode === 0x1000000 || mode === 0x2000000;
  }
  isBgPalette(): boolean {
    const mode = this.getBgColorMode();
    return mode === 0x1000000 || mode === 0x2000000;
  }
  isFgDefault(): boolean {
    return this.getFgColorMode() === 0;
  }
  isBgDefault(): boolean {
    return this.getBgColorMode() === 0;
  }
  isAttributeDefault(): boolean {
    return (
      this.isFgDefault() &&
      this.isBgDefault() &&
      !this.isBold() &&
      !this.isItalic() &&
      !this.isDim() &&
      !this.isBlink() &&
      !this.isInverse() &&
      !this.isInvisible() &&
      !this.isStrikethrough() &&
      !this.isOverline() &&
      !this.isUnderline()
    );
  }
}

class BufferLine implements IBufferLine {
  row: PackedBufferRow;
  length: number;

  constructor(row: PackedBufferRow, cols: number) {
    this.row = row;
    this.length = Math.max(cols, row.cells.length / CELL_WORDS);
  }

  get isWrapped(): boolean {
    return this.row.wrapContinuation;
  }

  resize(cols: number): void {
    this.length = Math.max(cols, this.row.cells.length / CELL_WORDS);
  }

  getCell(x: number, cell?: IBufferCell): IBufferCell | undefined {
    if (x < 0 || x >= this.length) return undefined;
    const target = cell instanceof BufferCell ? cell : new BufferCell();
    return target.loadPacked(this.row, x);
  }

  translateToString(trimRight = false, startColumn = 0, endColumn = this.length): string {
    let value = '';
    for (let x = Math.max(0, startColumn); x < Math.min(this.length, endColumn); x += 1) {
      const offset = x * CELL_WORDS;
      const content = this.row.cells[offset] ?? 0;
      const width = (content >>> CONTENT_WIDTH_SHIFT) & 0x3;
      if (width === 2 || width === 3) continue;
      value +=
        (content & CONTENT_COMBINED) !== 0
          ? (findSparseValue(this.row.strings, x) ?? ' ')
          : codepointText(content & CONTENT_CODEPOINT_MASK) || ' ';
    }
    return trimRight ? value.replace(/\s+$/u, '') : value;
  }
}

/** Where a {@link BufferView} reads its metadata and rows. */
export interface BufferViewSource {
  state(): TerminalBufferState;
  rows(start: number, end: number): readonly PackedBufferRow[];
}

/** How the active screen's rows moved and changed since the previous synchronization. */
export interface BufferChanges {
  readonly state: TerminalBufferState;
  /** Rows pruned from the top of history; every older index moved up by this many rows. */
  readonly trimmed: number;
  /** Row identity was lost and every cached row must be dropped. */
  readonly reset: boolean;
  /** First index whose content may have changed; rows before it are unchanged. */
  readonly dirtyFrom: number;
}

/** The core buffer source a {@link BufferNamespace} synchronizes from. */
export interface BufferNamespaceSource extends BufferViewSource {
  normalState(): TerminalBufferState;
  normalRows(start: number, end: number): readonly PackedBufferRow[];
}

/** Rows read from the source at once when a line is first requested. */
const BLOCK_ROWS = 64;

/**
 * One xterm buffer whose rows are read from Ghostty on demand.
 *
 * @remarks
 * Lines are cached in blocks of {@link BLOCK_ROWS} rows. Block keys count every row the view has
 * seen, including pruned ones, so pruning history moves no cached line. Without a source the view
 * holds one screen of blank rows, like xterm's inactive alternate buffer.
 */
export class BufferView implements IBuffer {
  readonly type: 'normal' | 'alternate';
  private source: BufferViewSource | null = null;
  private stateValue: TerminalBufferState | null = null;
  private readonly blocks = new Map<number, Array<BufferLine | undefined>>();
  /** Rows pruned since the cache was last cleared; added to an index to find its block. */
  private trimmedRows = 0;
  private cols: number;
  private rows: number;

  constructor(type: 'normal' | 'alternate', cols: number, rows: number) {
    this.type = type;
    this.cols = cols;
    this.rows = rows;
  }

  get length(): number {
    return this.state()?.totalRows ?? this.rows;
  }
  get baseY(): number {
    return this.state()?.scrollbackRows ?? 0;
  }
  get viewportY(): number {
    return this.state()?.viewportY ?? 0;
  }
  get cursorX(): number {
    return this.state()?.cursorX ?? 0;
  }
  get cursorY(): number {
    return this.state()?.cursorY ?? 0;
  }

  /** Serves `source`. Its state is `state` when known, or read when first needed. */
  attach(source: BufferViewSource, state?: TerminalBufferState): void {
    this.source = source;
    this.stateValue = state ?? null;
    this.clear();
  }

  /** Serves one screen of blank rows. */
  detach(): void {
    if (!this.source) return;
    this.source = null;
    this.stateValue = null;
    this.clear();
  }

  /** Whether the view currently serves `source`. */
  serves(source: BufferViewSource): boolean {
    return this.source === source;
  }

  /** Drops cached lines that `changes` moved out of the buffer or may have changed. */
  apply(changes: BufferChanges): void {
    this.stateValue = changes.state;
    if (changes.reset) {
      this.clear();
      return;
    }
    this.trimmedRows += changes.trimmed;
    const firstKept = Math.floor(this.trimmedRows / BLOCK_ROWS);
    const firstDirty = Math.floor((changes.dirtyFrom + this.trimmedRows) / BLOCK_ROWS);
    for (const key of this.blocks.keys()) {
      if (key < firstKept || key >= firstDirty) this.blocks.delete(key);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    if (rows === this.rows) return;
    this.rows = rows;
    if (!this.source) this.clear();
  }

  getLine(y: number): IBufferLine | undefined {
    return this.line(y);
  }

  getHyperlink(y: number, x: number): string | undefined {
    const row = this.line(y)?.row;
    return row ? findSparseValue(row.hyperlinks, x) : undefined;
  }

  getNullCell(): IBufferCell {
    return new BufferCell();
  }

  private state(): TerminalBufferState | null {
    if (!this.stateValue && this.source) this.stateValue = this.source.state();
    return this.stateValue;
  }

  private line(y: number): BufferLine | undefined {
    if (!Number.isInteger(y) || y < 0 || y >= this.length) return undefined;
    const position = y + this.trimmedRows;
    const key = Math.floor(position / BLOCK_ROWS);
    let line = this.blocks.get(key)?.[position - key * BLOCK_ROWS];
    if (!line) line = this.loadBlock(key)[position - key * BLOCK_ROWS];
    line?.resize(this.cols);
    return line;
  }

  private loadBlock(key: number): Array<BufferLine | undefined> {
    const first = key * BLOCK_ROWS - this.trimmedRows;
    const start = Math.max(0, first);
    const end = Math.min(this.length, first + BLOCK_ROWS);
    const block: Array<BufferLine | undefined> = new Array(BLOCK_ROWS);
    for (const row of this.source?.rows(start, end) ?? []) {
      if (row.index >= start && row.index < end)
        block[row.index - first] = new BufferLine(row, this.cols);
    }
    for (let index = start; index < end; index += 1)
      block[index - first] ??= blankLine(this.cols, index);
    this.blocks.set(key, block);
    return block;
  }

  private clear(): void {
    this.blocks.clear();
    this.trimmedRows = 0;
  }
}

export class BufferNamespace implements IBufferNamespace {
  readonly normal: BufferView;
  readonly alternate: BufferView;
  private activeValue: BufferView;
  private activeSource: BufferViewSource | null = null;
  private normalSource: BufferViewSource | null = null;
  private readonly change = new EventEmitter<IBuffer>();
  readonly onBufferChange = this.change.event;

  constructor(cols: number, rows: number) {
    this.normal = new BufferView('normal', cols, rows);
    this.alternate = new BufferView('alternate', cols, rows);
    this.activeValue = this.normal;
  }

  get active(): IBuffer {
    return this.activeValue;
  }

  setAlternate(active: boolean): void {
    const next = active ? this.alternate : this.normal;
    if (next === this.activeValue) return;
    this.activeValue = next;
    this.change.fire(next);
  }

  /**
   * Applies changes read from `source`. While the alternate screen is active, the normal buffer
   * reads Ghostty's normal screen and drops its cache on every change, since a single write can
   * leave the alternate screen and come back.
   */
  sync(source: BufferNamespaceSource, changes: BufferChanges): void {
    if (!this.activeSource) {
      this.activeSource = { state: () => source.state(), rows: (s, e) => source.rows(s, e) };
      this.normalSource = {
        state: () => source.normalState(),
        rows: (s, e) => source.normalRows(s, e),
      };
    }
    const active = this.activeSource;
    if (changes.state.screen === 'alternate') {
      if (!this.alternate.serves(active)) this.alternate.attach(active);
      this.alternate.apply(changes);
      if (this.normalSource) this.normal.attach(this.normalSource);
    } else {
      if (!this.normal.serves(active)) this.normal.attach(active);
      this.normal.apply(changes);
      this.alternate.detach();
    }
    this.setAlternate(changes.state.screen === 'alternate');
  }

  resize(cols: number, rows: number): void {
    this.normal.resize(cols, rows);
    this.alternate.resize(cols, rows);
  }

  /** @internal Returns Ghostty cell metadata for compatibility services such as OSC 8 links. */
  cellAt(y: number, x: number): { readonly hyperlinkUri?: string } | undefined {
    const hyperlinkUri = this.activeValue.getHyperlink(y, x);
    return hyperlinkUri ? { hyperlinkUri } : undefined;
  }

  dispose(): void {
    this.change.dispose();
  }
}

const NO_CELLS = new Uint32Array(0);

/** A row without cells; every column reads as a blank default cell. */
function blankLine(cols: number, y: number): BufferLine {
  return new BufferLine(
    {
      index: y,
      cells: NO_CELLS,
      strings: [],
      hyperlinks: [],
      wrapped: false,
      wrapContinuation: false,
    },
    cols
  );
}

function packCell(cell: RenderCell): {
  readonly content: number;
  readonly foreground: number;
  readonly background: number;
  readonly chars: string;
} {
  const chars = cell.text;
  const firstCodepoint = chars.codePointAt(0) ?? 0;
  const combined = chars.length > (firstCodepoint > 0xffff ? 2 : firstCodepoint > 0 ? 1 : 0);
  const codepoint = combined ? lastCodepoint(chars) : firstCodepoint;
  const width =
    cell.width === 'wide'
      ? 1
      : cell.width === 'spacer-tail'
        ? 2
        : cell.width === 'spacer-head'
          ? 3
          : 0;
  return {
    content:
      (codepoint & CONTENT_CODEPOINT_MASK) |
      (width << CONTENT_WIDTH_SHIFT) |
      (combined ? CONTENT_COMBINED : 0) |
      ((cell.style.underline & 0x7) << CONTENT_UNDERLINE_SHIFT) |
      CONTENT_PRESENT,
    foreground:
      colorMode(cell.foregroundSource, cell.foreground) |
      encodedColor(cell.foregroundSource, cell.foreground) |
      (cell.style.bold ? 1 << 26 : 0) |
      (cell.style.italic ? 1 << 27 : 0) |
      (cell.style.faint ? 1 << 28 : 0),
    background:
      colorMode(cell.backgroundSource, cell.background) |
      encodedColor(cell.backgroundSource, cell.background) |
      (cell.style.blink ? 1 << 26 : 0) |
      (cell.style.inverse ? 1 << 27 : 0) |
      (cell.style.invisible ? 1 << 28 : 0) |
      (cell.style.strikethrough ? 1 << 29 : 0) |
      (cell.style.overline ? 1 << 30 : 0),
    chars,
  };
}

function codepointText(codepoint: number): string {
  return codepoint > 0 ? String.fromCodePoint(codepoint) : '';
}

function lastCodepoint(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; ) {
    result = value.codePointAt(index) ?? 0;
    index += result > 0xffff ? 2 : 1;
  }
  return result;
}

function findSparseValue(
  values: readonly PackedBufferString[],
  column: number
): string | undefined {
  for (const [candidate, value] of values) {
    if (candidate === column) return value;
    if (candidate > column) return undefined;
  }
  return undefined;
}

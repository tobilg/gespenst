import type {
  CellColor,
  RenderCell,
  RgbColor,
  TerminalBufferRow,
  TerminalBufferSnapshot,
} from '@gespenst/core';
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
  readonly id?: string;
  readonly cells: Uint32Array;
  readonly strings: readonly PackedBufferString[];
  readonly hyperlinks: readonly PackedBufferString[];
  readonly wrapped: boolean;
  readonly wrapContinuation: boolean;
}

export interface PackedBufferSnapshot {
  readonly state: TerminalBufferSnapshot['state'];
  readonly rows: readonly PackedBufferRow[];
  /** Explicit journal operations emitted by the version-matched core bridge. */
  readonly trimmed?: number;
  readonly appendStart?: number;
  readonly reset?: boolean;
}

export interface BufferUpdateResult {
  readonly missing: { readonly start: number; readonly end: number } | null;
  readonly trimmed: number;
  readonly identityReset: boolean;
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

  update(row: PackedBufferRow, cols: number): void {
    this.row = row;
    this.resize(cols);
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

function packedRow(row: TerminalBufferRow): PackedBufferRow {
  let cellCount = row.cells.length;
  while (cellCount > 0 && isDefaultBlank(row.cells[cellCount - 1])) cellCount -= 1;
  const cells = new Uint32Array(cellCount * CELL_WORDS);
  const strings: PackedBufferString[] = [];
  const hyperlinks: PackedBufferString[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    const cell = row.cells[index];
    if (!cell) continue;
    const packed = packCell(cell);
    const offset = cell.x * CELL_WORDS;
    if (offset < 0 || offset + 2 >= cells.length) continue;
    cells[offset] = packed.content;
    cells[offset + 1] = packed.foreground;
    cells[offset + 2] = packed.background;
    if ((packed.content & CONTENT_COMBINED) !== 0) strings.push([cell.x, packed.chars]);
    if (cell.hyperlinkUri) hyperlinks.push([cell.x, cell.hyperlinkUri]);
  }
  return {
    index: row.index,
    id: row.id,
    cells,
    strings,
    hyperlinks,
    wrapped: row.wrapped,
    wrapContinuation: row.wrapContinuation,
  };
}

export class BufferView implements IBuffer {
  readonly type: 'normal' | 'alternate';
  cursorY = 0;
  cursorX = 0;
  viewportY = 0;
  baseY = 0;
  private lines: Array<BufferLine | undefined> = [];
  private head = 0;
  private lengthValue = 0;
  private definedCount = 0;
  private cols: number;

  constructor(type: 'normal' | 'alternate', cols: number, rows: number, capacity = rows) {
    this.type = type;
    this.cols = cols;
    this.ensureCapacity(Math.max(rows, capacity));
    this.setLength(rows, true);
  }

  get length(): number {
    return this.lengthValue;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    if (this.lengthValue < rows) this.setLength(rows, true);
  }

  reserve(capacity: number): void {
    this.ensureCapacity(capacity);
  }

  update(
    snapshot: TerminalBufferSnapshot | PackedBufferSnapshot,
    cols: number
  ): BufferUpdateResult {
    const { state } = snapshot;
    const rows = snapshot.rows.map((row) => (isPackedRow(row) ? row : packedRow(row)));
    this.cols = cols;
    let needsFullRead = false;
    let trimmed = 0;
    let identityReset = false;
    this.cursorX = state.cursorX;
    this.cursorY = state.cursorY;
    this.baseY = state.scrollbackRows;
    this.viewportY = state.viewportY;

    if (isSemanticSnapshot(snapshot)) {
      const hadRows = this.hasRetainedRows();
      if (snapshot.reset) {
        identityReset = hadRows;
        this.resetStorage(state.totalRows);
      } else {
        trimmed = Math.min(snapshot.trimmed, this.lengthValue);
        if (trimmed > 0) this.trimFront(trimmed, state.totalRows);
        else this.setLength(state.totalRows);
      }
      for (const row of rows) this.setRow(row.index, row);
      return {
        missing: this.missingRange(snapshot.appendStart),
        trimmed,
        identityReset,
      };
    }

    const completePage = rows[0]?.index === 0 && rows.length === state.totalRows;
    const retained = rows.find((row) => row.id !== undefined && this.findRowIndex(row.id) >= 0);
    const previousIndex = retained?.id ? this.findRowIndex(retained.id) : -1;
    const shift = retained && previousIndex >= 0 ? retained.index - previousIndex : 0;
    trimmed = Math.max(0, -shift);
    if (completePage) {
      identityReset = this.hasRetainedRows() && rows.length > 0 && !retained;
      this.resetStorage(state.totalRows);
    } else if (this.definedCount > 0 && rows.length > 0) {
      const first = rows[0];
      if (retained && previousIndex >= 0) {
        if (shift < 0) this.trimFront(-shift, state.totalRows);
        else if (shift > 0) needsFullRead = true;
      } else if (first && this.getLineValue(first.index)) {
        needsFullRead = true;
      }
    }
    if (!completePage && shift >= 0) {
      trimmed = Math.max(trimmed, Math.max(0, this.lengthValue - state.totalRows));
      this.setLength(state.totalRows);
    }
    for (const row of rows) this.setRow(row.index, row);
    if (needsFullRead)
      return {
        missing: { start: 0, end: state.totalRows },
        trimmed,
        identityReset,
      };
    if (this.definedCount === state.totalRows) return { missing: null, trimmed, identityReset };
    return {
      // A sparse/non-overlapping delta is exceptional. Request one authoritative page without
      // scanning every retained row; steady-state append/trim updates keep rowSlots complete.
      missing: { start: 0, end: state.totalRows },
      trimmed,
      identityReset,
    };
  }

  getLine(y: number): IBufferLine | undefined {
    if (y < 0 || y >= this.lengthValue) return undefined;
    const line = this.lines[this.slot(y)];
    line?.resize(this.cols);
    return line;
  }

  getHyperlink(y: number, x: number): string | undefined {
    const row = this.getLineValue(y)?.row;
    return row ? findSparseValue(row.hyperlinks, x) : undefined;
  }

  getNullCell(): IBufferCell {
    return new BufferCell();
  }

  private ensureCapacity(length: number): void {
    if (this.lines.length >= length) return;
    let capacity = Math.max(16, this.lines.length || 1);
    while (capacity < length) capacity *= 2;
    const nextLines: Array<BufferLine | undefined> = new Array(capacity);
    for (let index = 0; index < this.lengthValue; index += 1) {
      const previousSlot = this.slot(index);
      const line = this.lines[previousSlot];
      nextLines[index] = line;
    }
    this.lines = nextLines;
    this.head = 0;
  }

  private setLength(length: number, fillBlanks = false): void {
    const next = Math.max(0, length);
    this.ensureCapacity(next);
    if (next < this.lengthValue) {
      for (let index = next; index < this.lengthValue; index += 1) this.clearSlot(this.slot(index));
    } else {
      for (let index = this.lengthValue; index < next; index += 1) {
        const slot = this.slot(index);
        this.lines[slot] = fillBlanks ? blankLine(this.cols, index) : undefined;
        if (fillBlanks) this.definedCount += 1;
      }
    }
    this.lengthValue = next;
  }

  private resetStorage(length: number): void {
    this.lines = [];
    this.head = 0;
    this.lengthValue = 0;
    this.definedCount = 0;
    this.ensureCapacity(length);
    this.setLength(length);
  }

  private trimFront(count: number, totalRows: number): void {
    const amount = Math.min(Math.max(0, count), this.lengthValue);
    for (let index = 0; index < amount; index += 1) this.clearSlot(this.slot(index));
    if (this.lines.length > 0) this.head = (this.head + amount) % this.lines.length;
    this.lengthValue -= amount;
    this.setLength(totalRows);
  }

  private setRow(index: number, row: PackedBufferRow): void {
    if (index < 0 || index >= this.lengthValue) return;
    const slot = this.slot(index);
    const line = this.lines[slot];
    if (line) line.update(row, this.cols);
    else {
      this.lines[slot] = new BufferLine(row, this.cols);
      this.definedCount += 1;
    }
  }

  private clearSlot(slot: number): void {
    if (this.lines[slot]) this.definedCount -= 1;
    this.lines[slot] = undefined;
  }

  private findRowIndex(id: string): number {
    for (let index = 0; index < this.lengthValue; index += 1) {
      if (this.lines[this.slot(index)]?.row.id === id) return index;
    }
    return -1;
  }

  private hasRetainedRows(): boolean {
    for (let index = 0; index < this.lengthValue; index += 1) {
      const id = this.lines[this.slot(index)]?.row.id;
      if (id && !id.startsWith('blank:')) return true;
    }
    return false;
  }

  private missingRange(start: number): { readonly start: number; readonly end: number } | null {
    if (this.definedCount === this.lengthValue) return null;
    let first = -1;
    let last = -1;
    for (
      let index = Math.max(0, Math.min(start, this.lengthValue));
      index < this.lengthValue;
      index += 1
    ) {
      if (this.lines[this.slot(index)]) continue;
      if (first < 0) first = index;
      last = index;
    }
    if (first < 0) {
      for (let index = 0; index < Math.min(start, this.lengthValue); index += 1) {
        if (this.lines[this.slot(index)]) continue;
        if (first < 0) first = index;
        last = index;
      }
    }
    return first < 0 ? null : { start: first, end: last + 1 };
  }

  private getLineValue(index: number): BufferLine | undefined {
    if (index < 0 || index >= this.lengthValue) return undefined;
    return this.lines[this.slot(index)];
  }

  private slot(index: number): number {
    if (this.lines.length === 0) return 0;
    return (this.head + index) % this.lines.length;
  }
}

export class BufferNamespace implements IBufferNamespace {
  readonly normal: BufferView;
  readonly alternate: BufferView;
  private activeValue: BufferView;
  private readonly change = new EventEmitter<IBuffer>();
  readonly onBufferChange = this.change.event;

  constructor(cols: number, rows: number, scrollback = 0) {
    this.normal = new BufferView('normal', cols, rows, rows + scrollback);
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

  update(
    snapshot: TerminalBufferSnapshot | PackedBufferSnapshot,
    cols: number
  ): BufferUpdateResult {
    this.setAlternate(snapshot.state.screen === 'alternate');
    return this.activeValue.update(snapshot, cols);
  }

  resize(cols: number, rows: number): void {
    this.normal.resize(cols, rows);
    this.alternate.resize(cols, rows);
  }

  reserveNormal(capacity: number): void {
    this.normal.reserve(capacity);
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

function blankLine(cols: number, y: number): BufferLine {
  const cells = new Uint32Array(cols * CELL_WORDS);
  for (let x = 0; x < cols; x += 1) cells[x * CELL_WORDS] = CONTENT_PRESENT;
  return new BufferLine(
    {
      index: y,
      id: `blank:${y}`,
      cells,
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

function isPackedRow(row: TerminalBufferRow | PackedBufferRow): row is PackedBufferRow {
  return row.cells instanceof Uint32Array;
}

function isSemanticSnapshot(
  snapshot: TerminalBufferSnapshot | PackedBufferSnapshot
): snapshot is PackedBufferSnapshot &
  Required<Pick<PackedBufferSnapshot, 'trimmed' | 'appendStart' | 'reset'>> {
  return (
    'trimmed' in snapshot &&
    snapshot.trimmed !== undefined &&
    snapshot.appendStart !== undefined &&
    snapshot.reset !== undefined
  );
}

function isDefaultBlank(cell: RenderCell | undefined): boolean {
  if (!cell || cell.text || cell.width !== 'narrow' || cell.hyperlink) return false;
  const style = cell.style;
  return (
    cell.foreground === null &&
    cell.background === null &&
    (!cell.foregroundSource || cell.foregroundSource.mode === 'default') &&
    (!cell.backgroundSource || cell.backgroundSource.mode === 'default') &&
    !style.bold &&
    !style.italic &&
    !style.faint &&
    !style.blink &&
    !style.inverse &&
    !style.invisible &&
    !style.strikethrough &&
    !style.overline &&
    style.underline === 0
  );
}

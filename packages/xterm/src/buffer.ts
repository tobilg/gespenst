import type {
  CellColor,
  RenderCell,
  RenderRow,
  RgbColor,
  TerminalBufferRow,
  TerminalBufferSnapshot,
} from '@gespenst/core';
import type { IBuffer, IBufferCell, IBufferLine, IBufferNamespace } from '@xterm/xterm';
import { EventEmitter } from './events';

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
  private cell: RenderCell | null = null;

  load(cell: RenderCell | null): this {
    this.cell = cell;
    return this;
  }

  getWidth(): number {
    if (!this.cell || this.cell.width === 'spacer-tail' || this.cell.width === 'spacer-head')
      return 0;
    return this.cell.width === 'wide' ? 2 : 1;
  }
  getChars(): string {
    return this.cell?.text ?? '';
  }
  getCode(): number {
    const chars = [...(this.cell?.text ?? '')];
    return chars.at(-1)?.codePointAt(0) ?? 0;
  }
  getFgColorMode(): number {
    return colorMode(this.cell?.foregroundSource, this.cell?.foreground ?? null);
  }
  getBgColorMode(): number {
    return colorMode(this.cell?.backgroundSource, this.cell?.background ?? null);
  }
  getFgColor(): number {
    return encodedColor(this.cell?.foregroundSource, this.cell?.foreground ?? null);
  }
  getBgColor(): number {
    return encodedColor(this.cell?.backgroundSource, this.cell?.background ?? null);
  }
  isBold(): number {
    return this.cell?.style.bold ? 1 : 0;
  }
  isItalic(): number {
    return this.cell?.style.italic ? 1 : 0;
  }
  isDim(): number {
    return this.cell?.style.faint ? 1 : 0;
  }
  isUnderline(): number {
    return this.cell?.style.underline ?? 0;
  }
  isBlink(): number {
    return this.cell?.style.blink ? 1 : 0;
  }
  isInverse(): number {
    return this.cell?.style.inverse ? 1 : 0;
  }
  isInvisible(): number {
    return this.cell?.style.invisible ? 1 : 0;
  }
  isStrikethrough(): number {
    return this.cell?.style.strikethrough ? 1 : 0;
  }
  isOverline(): number {
    return this.cell?.style.overline ? 1 : 0;
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
    const cell = this.cell;
    return (
      this.isFgDefault() &&
      this.isBgDefault() &&
      !cell?.style.bold &&
      !cell?.style.italic &&
      !cell?.style.faint &&
      !cell?.style.blink &&
      !cell?.style.inverse &&
      !cell?.style.invisible &&
      !cell?.style.strikethrough &&
      !cell?.style.overline &&
      !cell?.style.underline
    );
  }
}

class BufferLine implements IBufferLine {
  readonly row: RenderRow;
  length: number;

  constructor(row: RenderRow, cols: number) {
    this.row = row;
    this.length = Math.max(cols, row.cells.length);
  }

  get isWrapped(): boolean {
    return this.row.wrapContinuation;
  }

  resize(cols: number): void {
    this.length = Math.max(cols, this.row.cells.length);
  }

  getCell(x: number, cell?: IBufferCell): IBufferCell | undefined {
    if (x < 0 || x >= this.length) return undefined;
    const target = cell instanceof BufferCell ? cell : new BufferCell();
    return target.load(this.row.cells[x] ?? null);
  }

  translateToString(trimRight = false, startColumn = 0, endColumn = this.length): string {
    let value = '';
    for (let x = Math.max(0, startColumn); x < Math.min(this.length, endColumn); x += 1) {
      const cell = this.row.cells[x];
      if (cell?.width === 'spacer-tail' || cell?.width === 'spacer-head') continue;
      value += cell?.text || ' ';
    }
    return trimRight ? value.replace(/\s+$/u, '') : value;
  }
}

function renderRow(row: TerminalBufferRow): RenderRow {
  return {
    y: row.index,
    text: row.text,
    cells: row.cells,
    wrapped: row.wrapped,
    wrapContinuation: row.wrapContinuation,
    selection: row.selection,
  };
}

export class BufferView implements IBuffer {
  readonly type: 'normal' | 'alternate';
  cursorY = 0;
  cursorX = 0;
  viewportY = 0;
  baseY = 0;
  private lines: BufferLine[];
  private rowIds: string[];

  constructor(type: 'normal' | 'alternate', cols: number, rows: number) {
    this.type = type;
    this.lines = blankLines(cols, rows);
    this.rowIds = [];
  }

  get length(): number {
    return this.lines.length;
  }

  resize(cols: number, rows: number): void {
    for (const line of this.lines) line?.resize(cols);
    while (this.lines.length < rows) this.lines.push(...blankLines(cols, 1));
  }

  update(snapshot: TerminalBufferSnapshot, cols: number): BufferUpdateResult {
    const { state, rows } = snapshot;
    let needsFullRead = false;
    let trimmed = 0;
    let identityReset = false;
    this.cursorX = state.cursorX;
    this.cursorY = state.cursorY;
    this.baseY = state.scrollbackRows;
    this.viewportY = state.viewportY;

    const completePage = rows[0]?.index === 0 && rows.length === state.totalRows;
    const retained = rows.find((row) => this.rowIds.includes(row.id));
    const previousIndex = retained ? this.rowIds.indexOf(retained.id) : -1;
    const shift = retained && previousIndex >= 0 ? retained.index - previousIndex : 0;
    trimmed = Math.max(0, -shift);
    if (completePage) {
      identityReset = this.rowIds.length > 0 && rows.length > 0 && !retained;
      this.lines = [];
      this.rowIds = [];
    } else if (this.rowIds.length > 0 && rows.length > 0) {
      const first = rows[0];
      if (retained && previousIndex >= 0) {
        if (shift !== 0) {
          const shiftedLines: BufferLine[] = [];
          const shiftedIds: string[] = [];
          for (let index = 0; index < this.lines.length; index += 1) {
            const next = index + shift;
            if (next < 0 || next >= state.totalRows) continue;
            const line = this.lines[index];
            const id = this.rowIds[index];
            if (line && id) {
              shiftedLines[next] = line;
              shiftedIds[next] = id;
            }
          }
          this.lines = shiftedLines;
          this.rowIds = shiftedIds;
        }
      } else if (first && this.rowIds[first.index]) {
        needsFullRead = true;
      }
    }

    this.lines.length = state.totalRows;
    this.rowIds.length = state.totalRows;
    for (const row of rows) {
      this.lines[row.index] = new BufferLine(renderRow(row), cols);
      this.rowIds[row.index] = row.id;
    }
    if (needsFullRead)
      return {
        missing: { start: 0, end: state.totalRows },
        trimmed,
        identityReset,
      };
    let start = -1;
    let end = -1;
    for (let index = 0; index < state.totalRows; index += 1) {
      if (!this.lines[index] || !this.rowIds[index]) {
        if (start === -1) start = index;
        end = index + 1;
      }
    }
    return {
      missing: start === -1 ? null : { start, end },
      trimmed,
      identityReset,
    };
  }

  getLine(y: number): IBufferLine | undefined {
    return this.lines[y];
  }

  getRenderCell(y: number, x: number): RenderCell | undefined {
    return this.lines[y]?.row.cells[x];
  }

  getNullCell(): IBufferCell {
    return new BufferCell();
  }
}

export class BufferNamespace implements IBufferNamespace {
  readonly normal: BufferView;
  readonly alternate: BufferView;
  private activeValue: BufferView;
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

  update(snapshot: TerminalBufferSnapshot, cols: number): BufferUpdateResult {
    this.setAlternate(snapshot.state.screen === 'alternate');
    return this.activeValue.update(snapshot, cols);
  }

  resize(cols: number, rows: number): void {
    this.normal.resize(cols, rows);
    this.alternate.resize(cols, rows);
  }

  /** @internal Returns Ghostty cell metadata for compatibility services such as OSC 8 links. */
  cellAt(y: number, x: number): RenderCell | undefined {
    return this.activeValue.getRenderCell(y, x);
  }

  dispose(): void {
    this.change.dispose();
  }
}

function blankLines(cols: number, rows: number): BufferLine[] {
  return Array.from({ length: rows }, (_, y) => {
    const row: RenderRow = {
      y,
      text: ' '.repeat(cols),
      cells: [],
      wrapped: false,
      wrapContinuation: false,
      selection: null,
    };
    return new BufferLine(row, cols);
  });
}

import type { AbiBitField } from './abi.js';
import type { Allocation, GhosttyBindings } from './bindings.js';
import type {
  CellColor,
  CellStyle,
  CellWidth,
  CursorStyle,
  DirtyState,
  RenderCell,
  RenderColors,
  RenderCursor,
  RenderFrame,
  RenderRow,
  SemanticContent,
  ViewportSnapshot,
} from './types.js';

const DEFAULT_STYLE: CellStyle = Object.freeze({
  bold: false,
  italic: false,
  faint: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: 0,
});

function dirtyState(value: number): DirtyState {
  return value === 2 ? 'full' : value === 1 ? 'partial' : 'clean';
}

function cursorStyle(value: number): CursorStyle {
  if (value === 0) return 'bar';
  if (value === 2) return 'underline';
  if (value === 3) return 'block-hollow';
  return 'block';
}

function cellWidth(value: number): CellWidth {
  if (value === 1) return 'wide';
  if (value === 2) return 'spacer-tail';
  if (value === 3) return 'spacer-head';
  return 'narrow';
}

function semanticContent(value: number): SemanticContent {
  if (value === 0) return 'output';
  if (value === 1) return 'input';
  if (value === 2) return 'prompt';
  return 'unknown';
}

function packedBits(low: number, high: number, field: AbiBitField): number {
  const mask = 2 ** field.width - 1;
  if (field.lsb >= 32) return (high >>> (field.lsb - 32)) & mask;
  if (field.lsb + field.width <= 32) return (low >>> field.lsb) & mask;
  return ((low >>> field.lsb) | (high << (32 - field.lsb))) & mask;
}

export class RenderReader {
  private readonly state: number;
  private readonly iterator: number;
  private readonly iteratorSlot: Allocation;
  private readonly cells: number;
  private readonly cellsSlot: Allocation;
  private readonly scalar: Allocation;
  private readonly yValue: Allocation;
  private readonly cursorValue: Allocation;
  private readonly colorsValue: Allocation;
  private readonly cellsView: Allocation;
  private readonly styleValue: Allocation;
  private readonly colorValue: Allocation;
  private readonly selectionValue: Allocation;
  private readonly graphemeValue: Allocation;
  private graphemeBytes: Allocation;
  private readonly rowCache = new Map<number, RenderRow>();
  private disposed = false;
  private lastFrame: RenderFrame | null = null;
  private readonly bindings: GhosttyBindings;
  private readonly cellBits: Readonly<{
    contentTag: AbiBitField;
    content: AbiBitField;
    codepoint: AbiBitField;
    styleId: AbiBitField;
    wide: AbiBitField;
    hyperlink: AbiBitField;
    semanticContent: AbiBitField;
    tagCodepoint: number;
    tagGrapheme: number;
  }>;

  constructor(bindings: GhosttyBindings) {
    this.bindings = bindings;
    this.cellBits = {
      contentTag: bindings.abi.bit('GhosttyCell', 'content_tag'),
      content: bindings.abi.bit('GhosttyCell', 'content'),
      codepoint: bindings.abi.bit('GhosttyCell', 'content', 'CODEPOINT', 'codepoint'),
      styleId: bindings.abi.bit('GhosttyCell', 'style_id'),
      wide: bindings.abi.bit('GhosttyCell', 'wide'),
      hyperlink: bindings.abi.bit('GhosttyCell', 'hyperlink'),
      semanticContent: bindings.abi.bit('GhosttyCell', 'semantic_content'),
      tagCodepoint: bindings.abi.value('GhosttyCellContentTag', 'CODEPOINT'),
      tagGrapheme: bindings.abi.value('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
    };
    const e = bindings.exports;
    this.state = bindings.createHandle('ghostty_render_state_new', (slot) =>
      e.ghostty_render_state_new(0, slot)
    );
    this.iterator = bindings.createHandle('ghostty_render_state_row_iterator_new', (slot) =>
      e.ghostty_render_state_row_iterator_new(0, slot)
    );
    this.iteratorSlot = bindings.alloc(4);
    this.iteratorSlot.view.setUint32(0, this.iterator, true);
    this.cells = bindings.createHandle('ghostty_render_state_row_cells_new', (slot) =>
      e.ghostty_render_state_row_cells_new(0, slot)
    );
    this.cellsSlot = bindings.alloc(4);
    this.cellsSlot.view.setUint32(0, this.cells, true);
    this.scalar = bindings.alloc(8);
    this.yValue = bindings.alloc(2);
    this.cursorValue = bindings.allocType('GhosttyRenderStateCursor', true);
    this.colorsValue = bindings.allocType('GhosttyRenderStateColors', true);
    this.cellsView = bindings.allocType('GhosttyCellsView');
    this.styleValue = bindings.allocType('GhosttyStyle', true);
    this.colorValue = bindings.allocType('GhosttyColorRgb');
    this.selectionValue = bindings.allocType('GhosttyRenderStateRowSelection', true);
    this.graphemeValue = bindings.allocType('GhosttyBuffer');
    this.graphemeBytes = bindings.alloc(64);
  }

  read(terminal: number): RenderFrame {
    this.ensureActive();
    const e = this.bindings.exports;
    this.bindings.check(e.ghostty_render_state_update(this.state, terminal), 'update render state');

    const cols = this.getU16('GhosttyRenderStateData', 'COLS');
    const rows = this.getU16('GhosttyRenderStateData', 'ROWS');
    const dirty = dirtyState(this.getI32('GhosttyRenderStateData', 'DIRTY'));
    const cursor = this.readCursor();
    const colors = this.readColors();
    const changedRows: RenderRow[] = [];

    if (dirty !== 'clean') {
      this.bindings.check(
        e.ghostty_render_state_get(
          this.state,
          this.bindings.abi.value('GhosttyRenderStateData', 'ROW_ITERATOR'),
          this.iteratorSlot.pointer
        ),
        'bind render row iterator'
      );
      while (e.ghostty_render_state_row_iterator_next_dirty(this.iterator, this.yValue.pointer)) {
        const y = this.yValue.view.getUint16(0, true);
        const row = this.readRow(y, cols);
        this.rowCache.set(y, row);
        changedRows.push(row);
      }
      this.bindings.check(e.ghostty_render_state_clean(this.state), 'clean render state');
    }

    for (const y of [...this.rowCache.keys()]) {
      if (y >= rows) this.rowCache.delete(y);
    }
    this.lastFrame = { cols, rows, dirty, cursor, colors, changedRows };
    return this.lastFrame;
  }

  snapshot(terminal: number): ViewportSnapshot {
    const frame = this.read(terminal);
    const blank = (y: number): RenderRow => ({
      y,
      text: ' '.repeat(frame.cols),
      cells: [],
      wrapped: false,
      wrapContinuation: false,
      selection: null,
    });
    const viewportRows = Array.from(
      { length: frame.rows },
      (_, y) => this.rowCache.get(y) ?? blank(y)
    );
    return { ...frame, viewportRows };
  }

  invalidate(): void {
    this.rowCache.clear();
    this.lastFrame = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const e = this.bindings.exports;
    e.ghostty_render_state_row_cells_free(this.cells);
    e.ghostty_render_state_row_iterator_free(this.iterator);
    e.ghostty_render_state_free(this.state);
    for (const allocation of [
      this.scalar,
      this.iteratorSlot,
      this.cellsSlot,
      this.yValue,
      this.cursorValue,
      this.colorsValue,
      this.cellsView,
      this.styleValue,
      this.colorValue,
      this.selectionValue,
      this.graphemeValue,
      this.graphemeBytes,
    ]) {
      allocation.free();
    }
    this.rowCache.clear();
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('RenderReader is disposed');
  }

  private stateGet(data: string, out: number): number {
    return this.bindings.exports.ghostty_render_state_get(
      this.state,
      this.bindings.abi.value('GhosttyRenderStateData', data),
      out
    );
  }

  private getU16(type: string, data: string): number {
    this.bindings.check(this.stateGet(data, this.scalar.pointer), `read ${type}.${data}`);
    return this.scalar.view.getUint16(0, true);
  }

  private getI32(type: string, data: string): number {
    this.bindings.check(this.stateGet(data, this.scalar.pointer), `read ${type}.${data}`);
    return this.scalar.view.getInt32(0, true);
  }

  private readCursor(): RenderCursor {
    this.cursorValue.bytes.fill(0);
    this.cursorValue.view.setUint32(0, this.cursorValue.length, true);
    this.bindings.check(this.stateGet('CURSOR', this.cursorValue.pointer), 'read render cursor');
    const abi = this.bindings.abi;
    const view = this.cursorValue.view;
    const hasPosition =
      view.getUint8(abi.field('GhosttyRenderStateCursor', 'viewport_has_value').offset) !== 0;
    return {
      x: hasPosition
        ? view.getUint16(abi.field('GhosttyRenderStateCursor', 'viewport_x').offset, true)
        : null,
      y: hasPosition
        ? view.getUint16(abi.field('GhosttyRenderStateCursor', 'viewport_y').offset, true)
        : null,
      wideTail: view.getUint8(abi.field('GhosttyRenderStateCursor', 'wide_tail').offset) !== 0,
      visible: view.getUint8(abi.field('GhosttyRenderStateCursor', 'visible').offset) !== 0,
      blinking: view.getUint8(abi.field('GhosttyRenderStateCursor', 'blinking').offset) !== 0,
      passwordInput:
        view.getUint8(abi.field('GhosttyRenderStateCursor', 'password_input').offset) !== 0,
      style: cursorStyle(
        view.getInt32(abi.field('GhosttyRenderStateCursor', 'visual_style').offset, true)
      ),
    };
  }

  private readColors(): RenderColors {
    this.colorsValue.bytes.fill(0);
    this.colorsValue.view.setUint32(0, this.colorsValue.length, true);
    this.bindings.check(this.stateGet('COLORS', this.colorsValue.pointer), 'read render colors');
    const abi = this.bindings.abi;
    const base = this.colorsValue.pointer;
    const paletteOffset = abi.field('GhosttyRenderStateColors', 'palette').offset;
    const palette = Array.from({ length: 256 }, (_, index) =>
      this.bindings.readColor(base + paletteOffset + index * 3)
    );
    const hasCursor =
      this.colorsValue.view.getUint8(
        abi.field('GhosttyRenderStateColors', 'cursor_has_value').offset
      ) !== 0;
    return {
      background: this.bindings.readColor(
        base + abi.field('GhosttyRenderStateColors', 'background').offset
      ),
      foreground: this.bindings.readColor(
        base + abi.field('GhosttyRenderStateColors', 'foreground').offset
      ),
      cursor: hasCursor
        ? this.bindings.readColor(base + abi.field('GhosttyRenderStateColors', 'cursor').offset)
        : null,
      palette,
    };
  }

  private readRow(y: number, cols: number): RenderRow {
    const e = this.bindings.exports;
    const rowData = (name: string) => this.bindings.abi.value('GhosttyRenderStateRowData', name);
    this.bindings.check(
      e.ghostty_render_state_row_get(this.iterator, rowData('RAW'), this.scalar.pointer),
      'read raw row'
    );
    const rawRow = this.scalar.view.getBigUint64(0, true);

    this.bindings.check(
      e.ghostty_render_state_row_get(this.iterator, rowData('CELLS'), this.cellsSlot.pointer),
      'bind row cells'
    );
    this.bindings.check(
      e.ghostty_render_state_row_get(this.iterator, rowData('CELLS_RAW'), this.cellsView.pointer),
      'read bulk row cells'
    );
    const view = this.cellsView.view;
    const cellsPointer = view.getUint32(
      this.bindings.abi.field('GhosttyCellsView', 'ptr').offset,
      true
    );
    const cellCount = Math.min(
      cols,
      view.getUint32(this.bindings.abi.field('GhosttyCellsView', 'len').offset, true)
    );
    const renderCells: RenderCell[] = [];
    const memory = new DataView(this.bindings.exports.memory.buffer);
    let text = '';
    for (let x = 0; x < cellCount; x += 1) {
      const pointer = cellsPointer + x * 8;
      const low = memory.getUint32(pointer, true);
      const high = memory.getUint32(pointer + 4, true);
      const tag = packedBits(low, high, this.cellBits.contentTag);
      const content = packedBits(low, high, this.cellBits.content);
      const codepoint =
        (content >>> this.cellBits.codepoint.lsb) & (2 ** this.cellBits.codepoint.width - 1);
      const styleId = packedBits(low, high, this.cellBits.styleId);
      const width = cellWidth(packedBits(low, high, this.cellBits.wide));
      const hyperlink = packedBits(low, high, this.cellBits.hyperlink) === 1;
      const semantic = semanticContent(packedBits(low, high, this.cellBits.semanticContent));
      const cellText =
        tag === this.cellBits.tagCodepoint && codepoint > 0
          ? String.fromCodePoint(codepoint)
          : tag === this.cellBits.tagGrapheme
            ? this.readGrapheme(x)
            : '';
      const style = styleId === 0 ? DEFAULT_STYLE : this.readStyle(x);
      const foreground = styleId === 0 ? null : this.readOptionalColor(x, 'FG_COLOR');
      const textContentTag =
        tag === this.cellBits.tagCodepoint || tag === this.cellBits.tagGrapheme;
      const background =
        styleId === 0 && textContentTag ? null : this.readOptionalColor(x, 'BG_COLOR');
      const cell: RenderCell = {
        x,
        text: cellText,
        width,
        style,
        foreground,
        background,
        ...(styleId === 0
          ? {}
          : {
              foregroundSource: this.readStyleColorSource('fg_color'),
              backgroundSource: this.readStyleColorSource('bg_color'),
              underlineSource: this.readStyleColorSource('underline_color'),
            }),
        hyperlink,
        semanticContent: semantic,
      };
      renderCells.push(cell);
      if (width !== 'spacer-tail' && width !== 'spacer-head') text += cellText || ' ';
    }

    let selection: RenderRow['selection'] = null;
    this.selectionValue.bytes.fill(0);
    this.selectionValue.view.setUint32(0, this.selectionValue.length, true);
    const selectionResult = e.ghostty_render_state_row_get(
      this.iterator,
      rowData('SELECTION'),
      this.selectionValue.pointer
    );
    if (selectionResult === 0) {
      selection = {
        start: this.selectionValue.view.getUint16(
          this.bindings.abi.field('GhosttyRenderStateRowSelection', 'start_x').offset,
          true
        ),
        end: this.selectionValue.view.getUint16(
          this.bindings.abi.field('GhosttyRenderStateRowSelection', 'end_x').offset,
          true
        ),
      };
    }

    return {
      y,
      text,
      cells: renderCells,
      wrapped: this.readRowFlag(rawRow, 'WRAP'),
      wrapContinuation: this.readRowFlag(rawRow, 'WRAP_CONTINUATION'),
      selection,
    };
  }

  private readRowFlag(row: bigint, name: string): boolean {
    this.bindings.check(
      this.bindings.exports.ghostty_row_get(
        row,
        this.bindings.abi.value('GhosttyRowData', name),
        this.scalar.pointer
      ),
      `read row flag ${name}`
    );
    return this.scalar.view.getUint8(0) !== 0;
  }

  private selectCell(x: number): void {
    this.bindings.check(
      this.bindings.exports.ghostty_render_state_row_cells_select(this.cells, x),
      `select render cell ${x}`
    );
  }

  private cellGet(name: string, out: number): number {
    return this.bindings.exports.ghostty_render_state_row_cells_get(
      this.cells,
      this.bindings.abi.value('GhosttyRenderStateRowCellsData', name),
      out
    );
  }

  private readStyle(x: number): CellStyle {
    this.selectCell(x);
    this.styleValue.bytes.fill(0);
    this.styleValue.view.setUint32(0, this.styleValue.length, true);
    this.bindings.check(this.cellGet('STYLE', this.styleValue.pointer), 'read cell style');
    const field = (name: string) => this.bindings.abi.field('GhosttyStyle', name).offset;
    const view = this.styleValue.view;
    return {
      bold: view.getUint8(field('bold')) !== 0,
      italic: view.getUint8(field('italic')) !== 0,
      faint: view.getUint8(field('faint')) !== 0,
      blink: view.getUint8(field('blink')) !== 0,
      inverse: view.getUint8(field('inverse')) !== 0,
      invisible: view.getUint8(field('invisible')) !== 0,
      strikethrough: view.getUint8(field('strikethrough')) !== 0,
      overline: view.getUint8(field('overline')) !== 0,
      underline: view.getInt32(field('underline'), true),
    };
  }

  private readOptionalColor(x: number, name: 'FG_COLOR' | 'BG_COLOR') {
    this.selectCell(x);
    const result = this.cellGet(name, this.colorValue.pointer);
    if (result === this.bindings.abi.value('GhosttyResult', 'INVALID_VALUE')) return null;
    this.bindings.check(result, `read ${name}`);
    return this.bindings.readColor(this.colorValue.pointer);
  }

  private readStyleColorSource(fieldName: 'fg_color' | 'bg_color' | 'underline_color'): CellColor {
    const abi = this.bindings.abi;
    const base = abi.field('GhosttyStyle', fieldName).offset;
    const tag = this.styleValue.view.getInt32(
      base + abi.field('GhosttyStyleColor', 'tag').offset,
      true
    );
    const value = base + abi.field('GhosttyStyleColor', 'value').offset;
    if (tag === abi.value('GhosttyStyleColorTag', 'PALETTE'))
      return { mode: 'palette', value: this.styleValue.view.getUint8(value) };
    if (tag === abi.value('GhosttyStyleColorTag', 'RGB')) {
      return {
        mode: 'rgb',
        value: {
          r: this.styleValue.view.getUint8(value),
          g: this.styleValue.view.getUint8(value + 1),
          b: this.styleValue.view.getUint8(value + 2),
        },
      };
    }
    return { mode: 'default' };
  }

  private readGrapheme(x: number): string {
    this.selectCell(x);
    for (;;) {
      const view = this.graphemeValue.view;
      view.setUint32(
        this.bindings.abi.field('GhosttyBuffer', 'ptr').offset,
        this.graphemeBytes.pointer,
        true
      );
      view.setUint32(
        this.bindings.abi.field('GhosttyBuffer', 'cap').offset,
        this.graphemeBytes.length,
        true
      );
      view.setUint32(this.bindings.abi.field('GhosttyBuffer', 'len').offset, 0, true);
      const result = this.cellGet('GRAPHEMES_UTF8', this.graphemeValue.pointer);
      const length = view.getUint32(this.bindings.abi.field('GhosttyBuffer', 'len').offset, true);
      if (result === 0) return this.bindings.readString(this.graphemeBytes.pointer, length);
      if (result !== this.bindings.abi.value('GhosttyResult', 'OUT_OF_SPACE')) {
        this.bindings.check(result, 'read cell grapheme');
      }
      this.graphemeBytes.free();
      this.graphemeBytes = this.bindings.alloc(Math.max(length, 64));
    }
  }
}

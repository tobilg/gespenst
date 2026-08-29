import {
  XTERM_CELL_WORDS,
  type XtermCompatibilityRow,
  type XtermCompatibilityString,
} from '../internal/xterm-compatibility.js';
import type { AbiBitField } from './abi.js';
import type { Allocation, GhosttyBindings } from './bindings.js';
import type { BufferReader } from './buffer.js';
import type { DirtyState, TerminalBufferState } from './types.js';

const CONTENT_PRESENT = 1 << 27;

/**
 * A private render-state consumer dedicated to the xterm sidecar.
 *
 * It packs Ghostty's raw cells directly and deliberately avoids constructing the rich
 * `RenderFrame`/`RenderCell` graph used by the browser painter.
 */
export class XtermCompatibilityReader {
  private readonly state: number;
  private readonly iterator: number;
  private readonly iteratorSlot: Allocation;
  private readonly cells: number;
  private readonly cellsSlot: Allocation;
  private readonly scalar: Allocation;
  private readonly yValue: Allocation;
  private readonly cellsView: Allocation;
  private readonly styleValue: Allocation;
  private readonly graphemeValue: Allocation;
  private graphemeBytes: Allocation;
  private readonly multiKeys: Allocation;
  private readonly multiValues: Allocation;
  private readonly multiWritten: Allocation;
  private readonly rowFlags: Allocation;
  private disposed = false;
  private readonly bindings: GhosttyBindings;
  private readonly bits: Readonly<{
    contentTag: AbiBitField;
    content: AbiBitField;
    codepoint: AbiBitField;
    styleId: AbiBitField;
    wide: AbiBitField;
    hyperlink: AbiBitField;
    tagCodepoint: number;
    tagGrapheme: number;
  }>;

  constructor(bindings: GhosttyBindings) {
    this.bindings = bindings;
    this.bits = {
      contentTag: bindings.abi.bit('GhosttyCell', 'content_tag'),
      content: bindings.abi.bit('GhosttyCell', 'content'),
      codepoint: bindings.abi.bit('GhosttyCell', 'content', 'CODEPOINT', 'codepoint'),
      styleId: bindings.abi.bit('GhosttyCell', 'style_id'),
      wide: bindings.abi.bit('GhosttyCell', 'wide'),
      hyperlink: bindings.abi.bit('GhosttyCell', 'hyperlink'),
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
    this.cellsView = bindings.allocType('GhosttyCellsView');
    this.styleValue = bindings.allocType('GhosttyStyle', true);
    this.graphemeValue = bindings.allocType('GhosttyBuffer');
    this.graphemeBytes = bindings.alloc(64);
    this.multiKeys = bindings.alloc(3 * 4);
    this.multiValues = bindings.alloc(3 * 4);
    this.multiWritten = bindings.alloc(4);
    this.rowFlags = bindings.alloc(2);
  }

  read(
    terminal: number,
    state: TerminalBufferState,
    buffer: BufferReader
  ): { readonly dirty: DirtyState; readonly rows: readonly XtermCompatibilityRow[] } {
    this.ensureActive();
    const e = this.bindings.exports;
    this.bindings.check(e.ghostty_render_state_update(this.state, terminal), 'update xterm state');
    const usedBulkState = this.getMulti('ghostty_render_state_get_multi', this.state, [
      [this.bindings.abi.value('GhosttyRenderStateData', 'DIRTY'), this.scalar.pointer],
      [this.bindings.abi.value('GhosttyRenderStateData', 'COLS'), this.yValue.pointer],
      [
        this.bindings.abi.value('GhosttyRenderStateData', 'ROW_ITERATOR'),
        this.iteratorSlot.pointer,
      ],
    ]);
    const dirty = dirtyState(
      usedBulkState ? this.scalar.view.getInt32(0, true) : this.getI32('DIRTY')
    );
    if (dirty === 'clean') return { dirty, rows: [] };
    const cols = usedBulkState ? this.yValue.view.getUint16(0, true) : this.getU16('COLS');
    if (!usedBulkState)
      this.bindings.check(
        e.ghostty_render_state_get(
          this.state,
          this.bindings.abi.value('GhosttyRenderStateData', 'ROW_ITERATOR'),
          this.iteratorSlot.pointer
        ),
        'bind xterm render row iterator'
      );
    const rows: XtermCompatibilityRow[] = [];
    while (e.ghostty_render_state_row_iterator_next_dirty(this.iterator, this.yValue.pointer)) {
      const y = this.yValue.view.getUint16(0, true);
      rows.push(this.readRow(state.viewportY + y, cols, buffer, terminal));
    }
    this.bindings.check(e.ghostty_render_state_clean(this.state), 'clean xterm render state');
    return { dirty, rows };
  }

  invalidate(): void {
    // A fresh full update is requested by Ghostty after terminal resize/reset/restore. The
    // compatibility render state intentionally retains no JavaScript row cache to invalidate.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const e = this.bindings.exports;
    e.ghostty_render_state_row_cells_free(this.cells);
    e.ghostty_render_state_row_iterator_free(this.iterator);
    e.ghostty_render_state_free(this.state);
    for (const allocation of [
      this.iteratorSlot,
      this.cellsSlot,
      this.scalar,
      this.yValue,
      this.cellsView,
      this.styleValue,
      this.graphemeValue,
      this.graphemeBytes,
      this.multiKeys,
      this.multiValues,
      this.multiWritten,
      this.rowFlags,
    ])
      allocation.free();
  }

  private readRow(
    index: number,
    cols: number,
    buffer: BufferReader,
    terminal: number
  ): XtermCompatibilityRow {
    const e = this.bindings.exports;
    const rowData = (name: string) => this.bindings.abi.value('GhosttyRenderStateRowData', name);
    const usedBulkRow = this.getMulti('ghostty_render_state_row_get_multi', this.iterator, [
      [rowData('RAW'), this.scalar.pointer],
      [rowData('CELLS'), this.cellsSlot.pointer],
      [rowData('CELLS_RAW'), this.cellsView.pointer],
    ]);
    if (!usedBulkRow)
      this.bindings.check(
        e.ghostty_render_state_row_get(this.iterator, rowData('RAW'), this.scalar.pointer),
        'read raw xterm row'
      );
    const rawRow = this.scalar.view.getBigUint64(0, true);
    if (!usedBulkRow) {
      this.bindings.check(
        e.ghostty_render_state_row_get(this.iterator, rowData('CELLS'), this.cellsSlot.pointer),
        'bind xterm row cells'
      );
      this.bindings.check(
        e.ghostty_render_state_row_get(this.iterator, rowData('CELLS_RAW'), this.cellsView.pointer),
        'read raw xterm row cells'
      );
    }
    const cellsView = this.cellsView.view;
    const cellsPointer = cellsView.getUint32(
      this.bindings.abi.field('GhosttyCellsView', 'ptr').offset,
      true
    );
    const cellCount = Math.min(
      cols,
      cellsView.getUint32(this.bindings.abi.field('GhosttyCellsView', 'len').offset, true)
    );
    const cells = new Uint32Array(cellCount * XTERM_CELL_WORDS);
    const strings: XtermCompatibilityString[] = [];
    const hyperlinks: XtermCompatibilityString[] = [];
    const memory = new DataView(e.memory.buffer);
    let retainedCells = 0;
    let selectedBufferRow = false;

    for (let x = 0; x < cellCount; x += 1) {
      const pointer = cellsPointer + x * 8;
      const low = memory.getUint32(pointer, true);
      const high = memory.getUint32(pointer + 4, true);
      const tag = packedBits(low, high, this.bits.contentTag);
      const content = packedBits(low, high, this.bits.content);
      const codepoint =
        tag === this.bits.tagCodepoint
          ? (content >>> this.bits.codepoint.lsb) & (2 ** this.bits.codepoint.width - 1)
          : 0;
      const styleId = packedBits(low, high, this.bits.styleId);
      const width = packedBits(low, high, this.bits.wide);
      const hyperlink = packedBits(low, high, this.bits.hyperlink) === 1;
      let selected = false;
      const select = () => {
        if (selected) return;
        this.bindings.check(
          e.ghostty_render_state_row_cells_select(this.cells, x),
          `select xterm cell ${x}`
        );
        selected = true;
      };
      let text = codepoint > 0 ? String.fromCodePoint(codepoint) : '';
      let combined = false;
      if (tag === this.bits.tagGrapheme) {
        select();
        text = this.readGrapheme();
        combined = true;
      }
      let underline = 0;
      let foreground = 0;
      let background = 0;
      if (styleId !== 0) {
        select();
        ({ underline, foreground, background } = this.readStyleWords());
      }
      const offset = x * XTERM_CELL_WORDS;
      cells[offset] =
        ((combined ? lastCodepoint(text) : codepoint) & 0x1fffff) |
        ((width & 0x3) << 21) |
        (combined ? 1 << 23 : 0) |
        ((underline & 0x7) << 24) |
        CONTENT_PRESENT;
      cells[offset + 1] = foreground;
      cells[offset + 2] = background;
      if (combined) strings.push([x, text]);
      if (hyperlink) {
        if (!selectedBufferRow) {
          buffer.selectCompatibilityRow(terminal, index);
          selectedBufferRow = true;
        }
        const uri = buffer.compatibilityHyperlinkUri(x);
        if (uri) hyperlinks.push([x, uri]);
      }
      if (
        codepoint > 0 ||
        combined ||
        width !== 0 ||
        foreground !== 0 ||
        background !== 0 ||
        underline !== 0 ||
        hyperlink
      )
        retainedCells = x + 1;
    }

    const packed = retainedCells === cellCount ? cells : cells.slice(0, retainedCells * 3);
    const usedBulkFlags = this.getMulti('ghostty_row_get_multi', rawRow, [
      [this.bindings.abi.value('GhosttyRowData', 'WRAP'), this.rowFlags.pointer],
      [this.bindings.abi.value('GhosttyRowData', 'WRAP_CONTINUATION'), this.rowFlags.pointer + 1],
    ]);
    return {
      index,
      cells: packed,
      strings,
      hyperlinks,
      wrapped: usedBulkFlags
        ? this.rowFlags.view.getUint8(0) !== 0
        : this.readRowFlag(rawRow, 'WRAP'),
      wrapContinuation: usedBulkFlags
        ? this.rowFlags.view.getUint8(1) !== 0
        : this.readRowFlag(rawRow, 'WRAP_CONTINUATION'),
    };
  }

  private readStyleWords(): {
    readonly underline: number;
    readonly foreground: number;
    readonly background: number;
  } {
    this.styleValue.bytes.fill(0);
    this.styleValue.view.setUint32(0, this.styleValue.length, true);
    this.bindings.check(this.cellGet('STYLE', this.styleValue.pointer), 'read xterm cell style');
    const field = (name: string) => this.bindings.abi.field('GhosttyStyle', name).offset;
    const view = this.styleValue.view;
    const underline = view.getInt32(field('underline'), true);
    const foreground =
      styleColorWord(this.bindings, view, 'fg_color') |
      (view.getUint8(field('bold')) !== 0 ? 1 << 26 : 0) |
      (view.getUint8(field('italic')) !== 0 ? 1 << 27 : 0) |
      (view.getUint8(field('faint')) !== 0 ? 1 << 28 : 0);
    const background =
      styleColorWord(this.bindings, view, 'bg_color') |
      (view.getUint8(field('blink')) !== 0 ? 1 << 26 : 0) |
      (view.getUint8(field('inverse')) !== 0 ? 1 << 27 : 0) |
      (view.getUint8(field('invisible')) !== 0 ? 1 << 28 : 0) |
      (view.getUint8(field('strikethrough')) !== 0 ? 1 << 29 : 0) |
      (view.getUint8(field('overline')) !== 0 ? 1 << 30 : 0);
    return { underline, foreground, background };
  }

  private readGrapheme(): string {
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
      if (result !== this.bindings.abi.value('GhosttyResult', 'OUT_OF_SPACE'))
        this.bindings.check(result, 'read xterm cell grapheme');
      this.graphemeBytes.free();
      this.graphemeBytes = this.bindings.alloc(Math.max(length, 64));
    }
  }

  private readRowFlag(row: bigint, name: string): boolean {
    this.bindings.check(
      this.bindings.exports.ghostty_row_get(
        row,
        this.bindings.abi.value('GhosttyRowData', name),
        this.scalar.pointer
      ),
      `read xterm row ${name.toLowerCase()}`
    );
    return this.scalar.view.getUint8(0) !== 0;
  }

  private cellGet(name: string, out: number): number {
    return this.bindings.exports.ghostty_render_state_row_cells_get(
      this.cells,
      this.bindings.abi.value('GhosttyRenderStateRowCellsData', name),
      out
    );
  }

  private stateGet(data: string, out: number): number {
    return this.bindings.exports.ghostty_render_state_get(
      this.state,
      this.bindings.abi.value('GhosttyRenderStateData', data),
      out
    );
  }

  private getMulti(
    name:
      | 'ghostty_render_state_get_multi'
      | 'ghostty_render_state_row_get_multi'
      | 'ghostty_row_get_multi',
    handle: number | bigint,
    entries: readonly (readonly [key: number, output: number])[]
  ): boolean {
    const candidate = this.bindings.exports[name];
    if (typeof candidate !== 'function') return false;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      this.multiKeys.view.setInt32(index * 4, entry[0], true);
      this.multiValues.view.setUint32(index * 4, entry[1], true);
    }
    this.multiWritten.view.setUint32(0, 0, true);
    const result = candidate(
      handle,
      entries.length,
      this.multiKeys.pointer,
      this.multiValues.pointer,
      this.multiWritten.pointer
    ) as number;
    this.bindings.check(result, name);
    return true;
  }

  private getU16(data: string): number {
    this.bindings.check(this.stateGet(data, this.scalar.pointer), `read xterm state ${data}`);
    return this.scalar.view.getUint16(0, true);
  }

  private getI32(data: string): number {
    this.bindings.check(this.stateGet(data, this.scalar.pointer), `read xterm state ${data}`);
    return this.scalar.view.getInt32(0, true);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('XtermCompatibilityReader is disposed');
  }
}

function dirtyState(value: number): DirtyState {
  return value === 2 ? 'full' : value === 1 ? 'partial' : 'clean';
}

function packedBits(low: number, high: number, field: AbiBitField): number {
  const mask = 2 ** field.width - 1;
  if (field.lsb >= 32) return (high >>> (field.lsb - 32)) & mask;
  if (field.lsb + field.width <= 32) return (low >>> field.lsb) & mask;
  return ((low >>> field.lsb) | (high << (32 - field.lsb))) & mask;
}

function styleColorWord(
  bindings: GhosttyBindings,
  view: DataView,
  fieldName: 'fg_color' | 'bg_color'
): number {
  const abi = bindings.abi;
  const base = abi.field('GhosttyStyle', fieldName).offset;
  const tag = view.getInt32(base + abi.field('GhosttyStyleColor', 'tag').offset, true);
  const value = base + abi.field('GhosttyStyleColor', 'value').offset;
  if (tag === abi.value('GhosttyStyleColorTag', 'PALETTE')) {
    const palette = view.getUint8(value);
    return palette | (palette < 16 ? 1 << 24 : 2 << 24);
  }
  if (tag === abi.value('GhosttyStyleColorTag', 'RGB'))
    return (
      (view.getUint8(value) << 16) |
      (view.getUint8(value + 1) << 8) |
      view.getUint8(value + 2) |
      (3 << 24)
    );
  return 0;
}

function lastCodepoint(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; ) {
    result = value.codePointAt(index) ?? 0;
    index += result > 0xffff ? 2 : 1;
  }
  return result;
}

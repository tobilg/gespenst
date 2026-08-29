import type {
  CellColor,
  DirtyState,
  InputSource,
  RenderCell,
  RenderColor,
  RenderRow,
  TerminalBufferState,
} from '../core/types.js';
import type { CoreBenchmarkTiming } from './benchmark.js';

/** Runtime-only bridge key shared with `@gespenst/xterm` without expanding the public API. */
export const XTERM_COMPATIBILITY_BRIDGE = Symbol.for('@gespenst/core/xterm-compatibility');

/** Three packed 32-bit words are used for every xterm-compatible cell. @internal */
export const XTERM_CELL_WORDS = 3 as const;

/** A sparse string associated with a packed cell column. @internal */
export type XtermCompatibilityString = readonly [column: number, value: string];

/** One packed row positioned in the retained active buffer. @internal */
export interface XtermCompatibilityRow {
  readonly index: number;
  readonly cells: Uint32Array;
  readonly strings: readonly XtermCompatibilityString[];
  readonly hyperlinks: readonly XtermCompatibilityString[];
  readonly wrapped: boolean;
  readonly wrapContinuation: boolean;
}

/** Incremental state captured at one parser checkpoint. @internal */
export interface XtermCompatibilityUpdate {
  readonly state: TerminalBufferState;
  readonly dirty: DirtyState;
  /** Rows removed from the head before applying this update. */
  readonly trimmed: number;
  /** First absolute row appended by this update, or `state.totalRows` when none were appended. */
  readonly appendStart: number;
  /** Whether retained-row identity was replaced and the sidecar must reset. */
  readonly reset: boolean;
  readonly rows: readonly XtermCompatibilityRow[];
}

/** All compatibility deltas produced by one public xterm write batch. @internal */
export interface XtermCompatibilityBatch {
  readonly updates: readonly XtermCompatibilityUpdate[];
}

/** Private runtime capability consumed only by the version-matched compatibility package. */
export interface XtermCompatibilityBridge {
  onInput(listener: (data: string | Uint8Array, source: InputSource) => void): {
    readonly dispose: () => void;
  };
  writeAsync(
    data: Uint8Array,
    owned: boolean,
    boundaries: Uint32Array
  ): Promise<XtermCompatibilityBatch>;
  /** Measured equivalent used only by the repository benchmark harness. @internal */
  writeMeasured(
    data: Uint8Array,
    owned: boolean,
    boundaries: Uint32Array
  ): Promise<{ readonly batch: XtermCompatibilityBatch; readonly timing: CoreBenchmarkTiming }>;
}

/** Packs renderer cells into the same compact three-word shape used by xterm.js. @internal */
export function packXtermCompatibilityRow(row: RenderRow, index: number): XtermCompatibilityRow {
  let cellCount = row.cells.length;
  while (cellCount > 0 && isDefaultBlank(row.cells[cellCount - 1])) cellCount -= 1;
  const cells = new Uint32Array(cellCount * XTERM_CELL_WORDS);
  const strings: XtermCompatibilityString[] = [];
  const hyperlinks: XtermCompatibilityString[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    const cell = row.cells[index];
    if (!cell) continue;
    const offset = cell.x * XTERM_CELL_WORDS;
    if (offset < 0 || offset + 2 >= cells.length) continue;
    const firstCodepoint = cell.text.codePointAt(0) ?? 0;
    const combined = cell.text.length > (firstCodepoint > 0xffff ? 2 : firstCodepoint > 0 ? 1 : 0);
    const codepoint = combined ? lastCodepoint(cell.text) : firstCodepoint;
    cells[offset] =
      (codepoint & 0x1fffff) |
      (widthValue(cell) << 21) |
      (combined ? 1 << 23 : 0) |
      ((cell.style.underline & 0x7) << 24) |
      (1 << 27);
    cells[offset + 1] =
      colorWord(cell.foregroundSource, cell.foreground) |
      (cell.style.bold ? 1 << 26 : 0) |
      (cell.style.italic ? 1 << 27 : 0) |
      (cell.style.faint ? 1 << 28 : 0);
    cells[offset + 2] =
      colorWord(cell.backgroundSource, cell.background) |
      (cell.style.blink ? 1 << 26 : 0) |
      (cell.style.inverse ? 1 << 27 : 0) |
      (cell.style.invisible ? 1 << 28 : 0) |
      (cell.style.strikethrough ? 1 << 29 : 0) |
      (cell.style.overline ? 1 << 30 : 0);
    if (combined) strings.push([cell.x, cell.text]);
    if (cell.hyperlinkUri) hyperlinks.push([cell.x, cell.hyperlinkUri]);
  }
  return {
    index,
    cells,
    strings,
    hyperlinks,
    wrapped: row.wrapped,
    wrapContinuation: row.wrapContinuation,
  };
}

/** Transfer list for a compatibility delta sent across the terminal worker boundary. @internal */
export function xtermCompatibilityTransferables(update: XtermCompatibilityUpdate): Transferable[] {
  return update.rows.map((row) => row.cells.buffer);
}

/** Transfer list for every row contained in one compatibility write batch. @internal */
export function xtermCompatibilityBatchTransferables(
  batch: XtermCompatibilityBatch
): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  for (const update of batch.updates) {
    for (const row of update.rows) buffers.add(row.cells.buffer as ArrayBuffer);
  }
  return [...buffers];
}

/** Coalesces row cell payloads into bounded transferable slabs. @internal */
export function compactXtermCompatibilityBatch(
  batch: XtermCompatibilityBatch,
  maximumSlabBytes = 1024 * 1024
): XtermCompatibilityBatch {
  const maximumWords = Math.max(XTERM_CELL_WORDS, Math.floor(maximumSlabBytes / 4));
  const output: XtermCompatibilityUpdate[] = [];

  // Preserve update grouping while sharing at most one bounded backing buffer per group of rows.
  // Oversized individual rows retain their exact buffer rather than forcing a larger slab.
  for (const update of batch.updates) {
    const rows: XtermCompatibilityRow[] = [];
    let group: XtermCompatibilityRow[] = [];
    let words = 0;
    const flush = () => {
      if (group.length === 0) return;
      const cells = new Uint32Array(words);
      let offset = 0;
      for (const row of group) {
        cells.set(row.cells, offset);
        rows.push({ ...row, cells: cells.subarray(offset, offset + row.cells.length) });
        offset += row.cells.length;
      }
      group = [];
      words = 0;
    };
    for (const row of update.rows) {
      if (row.cells.length > maximumWords) {
        flush();
        rows.push(row);
        continue;
      }
      if (words + row.cells.length > maximumWords) flush();
      group.push(row);
      words += row.cells.length;
    }
    flush();
    output.push({ ...update, rows });
  }
  return { updates: output };
}

/** Folds segmented parser checkpoints into one final sidecar journal operation. @internal */
export function coalesceXtermCompatibilityBatch(
  updates: readonly XtermCompatibilityUpdate[]
): XtermCompatibilityBatch {
  const first = updates[0];
  const last = updates.at(-1);
  if (!first || !last) return { updates: [] };
  const initialRows = first.reset ? 0 : first.appendStart + first.trimmed;
  const staged = new Map<number, XtermCompatibilityRow>();
  let trimmed = 0;
  let reset = false;
  let dirty: DirtyState = 'clean';
  for (const update of updates) {
    if (update.dirty === 'full') dirty = 'full';
    else if (update.dirty === 'partial' && dirty === 'clean') dirty = 'partial';
    if (update.reset) {
      reset = true;
      trimmed = 0;
      staged.clear();
    } else if (update.trimmed > 0) {
      const shifted = [...staged.values()];
      staged.clear();
      for (const row of shifted) {
        const index = row.index - update.trimmed;
        if (index >= 0) staged.set(index, { ...row, index });
      }
      if (!reset) trimmed += update.trimmed;
    }
    for (const row of update.rows) staged.set(row.index, row);
  }
  return {
    updates: [
      {
        state: last.state,
        dirty,
        trimmed,
        appendStart: reset ? 0 : Math.max(0, initialRows - trimmed),
        reset,
        rows: [...staged.values()].sort((left, right) => left.index - right.index),
      },
    ],
  };
}

function widthValue(cell: RenderCell): number {
  if (cell.width === 'wide') return 1;
  if (cell.width === 'spacer-tail') return 2;
  if (cell.width === 'spacer-head') return 3;
  return 0;
}

function colorWord(source: CellColor | undefined, resolved: RenderColor | null): number {
  if (source?.mode === 'palette') {
    return (source.value & 0xffffff) | (source.value < 16 ? 1 << 24 : 2 << 24);
  }
  const value = source?.mode === 'rgb' ? source.value : resolved;
  if (!value) return 0;
  return (value.r << 16) | (value.g << 8) | value.b | (3 << 24);
}

function lastCodepoint(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; ) {
    result = value.codePointAt(index) ?? 0;
    index += result > 0xffff ? 2 : 1;
  }
  return result;
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

/** Coalesces frames that joined one asynchronous renderer boundary. @internal */
export function mergeXtermCompatibilityUpdates(
  updates: readonly XtermCompatibilityUpdate[]
): XtermCompatibilityUpdate {
  const update = coalesceXtermCompatibilityBatch(updates).updates[0];
  if (!update) throw new Error('A compatibility update requires at least one parser checkpoint');
  return update;
}

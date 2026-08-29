import { describe, expect, it } from 'vitest';
import type { RenderRow, TerminalBufferState } from '../src/core/types.js';
import {
  coalesceXtermCompatibilityBatch,
  compactXtermCompatibilityBatch,
  packXtermCompatibilityRow,
  XTERM_CELL_WORDS,
  xtermCompatibilityBatchTransferables,
  xtermCompatibilityTransferables,
} from '../src/internal/xterm-compatibility.js';

const state: TerminalBufferState = {
  screen: 'normal',
  totalRows: 1,
  scrollbackRows: 0,
  viewportY: 0,
  viewportLength: 1,
  cursorX: 0,
  cursorY: 0,
  revision: 1,
};

describe('packed xterm compatibility deltas', () => {
  it('uses three words per cell and keeps graphemes and hyperlinks sparse', () => {
    const row = packXtermCompatibilityRow(renderRow(), 4);

    expect(row.cells).toBeInstanceOf(Uint32Array);
    expect(row.cells.length).toBe(2 * XTERM_CELL_WORDS);
    expect(row.strings).toEqual([[1, 'é']]);
    expect(row.hyperlinks).toEqual([[1, 'https://gespenst.dev']]);
    expect(row.index).toBe(4);

    const update = {
      state,
      dirty: 'partial' as const,
      trimmed: 0,
      appendStart: state.totalRows,
      reset: false,
      rows: [row],
    };
    expect(xtermCompatibilityTransferables(update)).toEqual([row.cells.buffer]);

    const second = packXtermCompatibilityRow(renderRow(), 5);
    const batch = compactXtermCompatibilityBatch({
      updates: [{ ...update, rows: [row, second] }],
    });
    const packedRows = batch.updates[0]?.rows ?? [];
    expect(packedRows).toHaveLength(2);
    expect(packedRows[0]?.cells.buffer).toBe(packedRows[1]?.cells.buffer);
    expect(xtermCompatibilityBatchTransferables(batch)).toHaveLength(1);

    const coalesced = coalesceXtermCompatibilityBatch([
      {
        ...update,
        state: { ...state, totalRows: 3, scrollbackRows: 2 },
        trimmed: 1,
        appendStart: 2,
        rows: [
          { ...row, index: 1 },
          { ...second, index: 2 },
        ],
      },
      {
        ...update,
        state: { ...state, totalRows: 3, scrollbackRows: 2, revision: 2 },
        trimmed: 1,
        appendStart: 2,
        rows: [{ ...row, index: 2 }],
      },
    ]);
    expect(coalesced.updates).toHaveLength(1);
    expect(coalesced.updates[0]).toMatchObject({
      trimmed: 2,
      appendStart: 1,
      reset: false,
    });
    expect(coalesced.updates[0]?.rows.map((value) => value.index)).toEqual([0, 1, 2]);
  });
});

function renderRow(): RenderRow {
  const style = {
    bold: false,
    italic: false,
    faint: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: 0,
  } as const;
  return {
    y: 0,
    text: 'Aé',
    cells: [
      {
        x: 0,
        text: 'A',
        width: 'narrow',
        style,
        foreground: null,
        background: null,
        hyperlink: false,
        semanticContent: 'output',
      },
      {
        x: 1,
        text: 'é',
        width: 'narrow',
        style,
        foreground: null,
        background: null,
        hyperlink: true,
        hyperlinkUri: 'https://gespenst.dev',
        semanticContent: 'output',
      },
    ],
    wrapped: false,
    wrapContinuation: false,
    selection: null,
  };
}

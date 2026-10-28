import type { TerminalBufferState } from '@gespenst/core';
import { bench, describe } from 'vitest';
import { BufferView, type PackedBufferRow } from '../src/buffer';

const COLS = 120;
const ROWS = 40;

describe('xterm buffer synchronization', () => {
  for (const totalRows of [1_000, 10_000, 100_000]) {
    const value = scrollingCase(totalRows);
    bench(`append, trim, and read the viewport / ${label(totalRows)} retained rows`, () => {
      value.step();
    });
  }

  for (const totalRows of [1_000, 10_000]) {
    bench(`read every line once / ${label(totalRows)} retained rows`, () => {
      const view = new BufferView('normal', COLS, ROWS);
      view.attach(source(totalRows), state(totalRows));
      for (let y = 0; y < totalRows; y += 1) view.getLine(y);
    });
  }
});

/** Output scrolls one row per step at the scrollback limit, and the viewport is read each time. */
function scrollingCase(totalRows: number) {
  const view = new BufferView('normal', COLS, ROWS);
  const rowSource = source(totalRows);
  view.attach(rowSource, state(totalRows));
  for (let y = 0; y < totalRows; y += 1) view.getLine(y);
  return {
    step() {
      view.apply({
        state: state(totalRows),
        trimmed: 1,
        reset: false,
        dirtyFrom: totalRows - ROWS - 1,
      });
      for (let y = totalRows - ROWS; y < totalRows; y += 1) view.getLine(y);
    },
  };
}

function source(totalRows: number) {
  const cells = new Uint32Array(COLS * 3).fill((0x61 & 0x1fffff) | (1 << 27));
  return {
    state: () => state(totalRows),
    rows: (start: number, end: number): PackedBufferRow[] =>
      Array.from({ length: end - start }, (_, offset) => ({
        index: start + offset,
        cells,
        strings: [],
        hyperlinks: [],
        wrapped: false,
        wrapContinuation: false,
      })),
  };
}

function state(totalRows: number): TerminalBufferState {
  return {
    screen: 'normal',
    totalRows,
    scrollbackRows: totalRows - ROWS,
    viewportY: totalRows - ROWS,
    viewportLength: ROWS,
    cursorX: 0,
    cursorY: ROWS - 1,
    revision: 1,
  };
}

function label(value: number): string {
  return value.toLocaleString('en-US');
}

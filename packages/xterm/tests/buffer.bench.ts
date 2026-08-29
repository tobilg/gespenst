import type { RenderCell, TerminalBufferSnapshot } from '@gespenst/core';
import { bench, describe } from 'vitest';
import { BufferView } from '../src/buffer';

const tailReplacementCases = [1_000, 10_000, 100_000].map(tailReplacementCase);

describe('xterm incremental buffer synchronization', () => {
  for (const value of tailReplacementCases) {
    bench(`replace tail / ${value.totalRows.toLocaleString('en-US')} retained rows`, () => {
      value.update();
    });
  }

  for (const totalRows of [1_000, 10_000, 100_000]) {
    const value = appendTrimCase(totalRows);
    bench(`append and trim / ${totalRows.toLocaleString('en-US')} retained rows`, () => {
      value.update();
    });
  }

  for (const totalRows of [1_000, 10_000, 100_000]) {
    const view = new BufferView('normal', 120, 40);
    view.update(snapshot(totalRows), 120);
    let revision = 2;
    bench(`replace viewport / ${totalRows.toLocaleString('en-US')} retained rows`, () => {
      view.update(changedViewport(totalRows, revision), 120);
      revision += 1;
    });
  }
});

function tailReplacementCase(totalRows: number) {
  const view = new BufferView('normal', 120, 40);
  view.update(snapshot(totalRows), 120);
  let revision = 2;
  return {
    totalRows,
    update() {
      const index = totalRows - 1;
      view.update(
        {
          state: state(totalRows, revision),
          rows: [row(index, `row-${index}`, `changed-${revision}`)],
          trimmed: 0,
          appendStart: totalRows,
          reset: false,
        },
        120
      );
      revision += 1;
    },
  };
}

function appendTrimCase(totalRows: number) {
  const view = new BufferView('normal', 120, 40);
  view.update(snapshot(totalRows), 120);
  let firstId = `row-${totalRows - 1}`;
  let sequence = totalRows;
  let revision = 2;
  return {
    update() {
      const nextId = `row-${sequence}`;
      view.update(
        {
          state: state(totalRows, revision),
          rows: [row(totalRows - 2, firstId), row(totalRows - 1, nextId)],
          trimmed: 1,
          appendStart: totalRows - 1,
          reset: false,
        },
        120
      );
      firstId = nextId;
      sequence += 1;
      revision += 1;
    },
  };
}

function snapshot(totalRows: number): TerminalBufferSnapshot {
  return {
    state: state(totalRows, 1),
    rows: Array.from({ length: totalRows }, (_, index) => row(index, `row-${index}`)),
  };
}

function changedViewport(totalRows: number, revision: number) {
  const start = Math.max(0, totalRows - 40);
  return {
    state: state(totalRows, revision),
    rows: Array.from({ length: totalRows - start }, (_, offset) => {
      const index = start + offset;
      return row(index, `row-${index}`, `changed-${revision}-${index}`);
    }),
    trimmed: 0,
    appendStart: totalRows,
    reset: false,
  };
}

function state(totalRows: number, revision: number) {
  return {
    screen: 'normal' as const,
    totalRows,
    scrollbackRows: Math.max(0, totalRows - 40),
    viewportY: Math.max(0, totalRows - 40),
    viewportLength: Math.min(40, totalRows),
    cursorX: 0,
    cursorY: 39,
    revision,
  };
}

function row(index: number, id: string, text = id) {
  return {
    index,
    id,
    text,
    cells: [cell(text)],
    wrapped: false,
    wrapContinuation: false,
    selection: null,
  };
}

function cell(text: string): RenderCell {
  return {
    x: 0,
    text,
    width: 'narrow',
    foreground: null,
    background: null,
    hyperlink: false,
    semanticContent: 'output',
    style: {
      bold: false,
      italic: false,
      faint: false,
      blink: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      overline: false,
      underline: 0,
    },
  };
}

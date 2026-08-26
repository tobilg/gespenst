import type { RenderCell, TerminalBufferSnapshot } from '@gespenst/core';
import { describe, expect, it, vi } from 'vitest';
import { BufferCell, BufferNamespace, BufferView } from '../src/buffer';

describe('xterm buffer views', () => {
  it('maps every stable cell attribute and translates visual columns', () => {
    const view = new BufferView('normal', 5, 1);
    view.update(
      snapshot([
        styledCell(0, '😀', 'wide'),
        styledCell(1, '', 'spacer-tail'),
        styledCell(2, 'X', 'narrow'),
      ]),
      5
    );
    const line = view.getLine(0);
    const first = line?.getCell(0);
    const second = line?.getCell(2, first);

    expect(line?.length).toBe(5);
    expect(line?.isWrapped).toBe(true);
    expect(line?.translateToString()).toBe('😀X  ');
    expect(line?.translateToString(true, 0, 3)).toBe('😀X');
    expect(line?.getCell(-1)).toBeUndefined();
    expect(line?.getCell(5)).toBeUndefined();
    expect(second).toBe(first);
    expect(second?.getWidth()).toBe(1);
    expect(second?.getChars()).toBe('X');
    expect(second?.getCode()).toBe(88);
    expect(second?.getFgColorMode()).toBe(0x3000000);
    expect(second?.getBgColorMode()).toBe(0x3000000);
    expect(second?.getFgColor()).toBe(0x010203);
    expect(second?.getBgColor()).toBe(0x040506);
    expect(second?.isBold()).toBe(1);
    expect(second?.isItalic()).toBe(1);
    expect(second?.isDim()).toBe(1);
    expect(second?.isUnderline()).toBe(2);
    expect(second?.isBlink()).toBe(1);
    expect(second?.isInverse()).toBe(1);
    expect(second?.isInvisible()).toBe(1);
    expect(second?.isStrikethrough()).toBe(1);
    expect(second?.isOverline()).toBe(1);
    expect(second?.isFgRGB()).toBe(true);
    expect(second?.isBgRGB()).toBe(true);
    expect(second?.isFgPalette()).toBe(false);
    expect(second?.isBgPalette()).toBe(false);
    expect(second?.isFgDefault()).toBe(false);
    expect(second?.isBgDefault()).toBe(false);
    expect(second?.isAttributeDefault()).toBe(false);

    const palette = new BufferCell().load({
      ...styledCell(0, 'p', 'narrow'),
      foregroundSource: { mode: 'palette', value: 4 },
      backgroundSource: { mode: 'palette', value: 200 },
    });
    expect(palette.getFgColorMode()).toBe(0x1000000);
    expect(palette.getBgColorMode()).toBe(0x2000000);
    expect(palette.getFgColor()).toBe(4);
    expect(palette.getBgColor()).toBe(200);
    expect(palette.isFgPalette()).toBe(true);
    expect(palette.isBgPalette()).toBe(true);

    const empty = view.getNullCell();
    expect(empty.getWidth()).toBe(0);
    expect(empty.getChars()).toBe('');
    expect(empty.getCode()).toBe(0);
    expect(empty.isFgDefault()).toBe(true);
    expect(empty.isBgDefault()).toBe(true);
    expect(empty.isAttributeDefault()).toBe(true);
  });

  it('reports missing pages, shifts retained rows, and detects complete replacement', () => {
    const view = new BufferView('normal', 4, 2);
    const first = view.update(snapshotRows(['a', 'b', 'c'], 1), 4);
    expect(first).toEqual({ missing: null, trimmed: 0, identityReset: false });

    const partial = view.update(snapshotRows(['x'], 2, 2, 3), 4);
    expect(partial.missing).toEqual({ start: 0, end: 3 });
    expect(partial.identityReset).toBe(false);

    const shifted = view.update(snapshotRows(['b', 'c', 'd'], 3), 4);
    expect(shifted.trimmed).toBe(1);
    expect(shifted.identityReset).toBe(false);
    expect(view.getLine(0)?.translateToString(true)).toBe('b');

    const replaced = view.update(snapshotRows(['u', 'v'], 4), 4);
    expect(replaced.identityReset).toBe(true);
    expect(view.length).toBe(2);
  });

  it('switches normal and alternate buffers and emits only actual changes', () => {
    const namespace = new BufferNamespace(4, 2);
    const changes = vi.fn();
    const subscription = namespace.onBufferChange(changes);
    namespace.update(snapshotRows(['a', 'b'], 1), 4);
    namespace.setAlternate(false);
    expect(changes).not.toHaveBeenCalled();

    namespace.update(snapshotRows(['x', 'y'], 2, 0, 2, 'alternate'), 4);
    expect(namespace.active.type).toBe('alternate');
    expect(changes).toHaveBeenCalledOnce();
    namespace.setAlternate(true);
    expect(changes).toHaveBeenCalledOnce();
    subscription.dispose();
    namespace.dispose();
  });
});

function styledCell(x: number, text: string, width: RenderCell['width']): RenderCell {
  return {
    x,
    text,
    width,
    foreground: { r: 1, g: 2, b: 3 },
    background: { r: 4, g: 5, b: 6 },
    hyperlink: true,
    semanticContent: 'output',
    style: {
      bold: true,
      italic: true,
      faint: true,
      blink: true,
      inverse: true,
      invisible: true,
      strikethrough: true,
      overline: true,
      underline: 2,
    },
  };
}

function snapshot(cells: readonly RenderCell[]): TerminalBufferSnapshot {
  return {
    state: state(1, 1, 'normal'),
    rows: [
      {
        index: 0,
        id: 'row',
        text: '😀 X',
        cells,
        wrapped: true,
        wrapContinuation: true,
        selection: null,
      },
    ],
  };
}

function snapshotRows(
  ids: readonly string[],
  revision: number,
  start = 0,
  totalRows = ids.length,
  screen: 'normal' | 'alternate' = 'normal'
): TerminalBufferSnapshot {
  return {
    state: state(totalRows, revision, screen),
    rows: ids.map((id, index) => ({
      index: start + index,
      id,
      text: id,
      cells: [plainCell(0, id)],
      wrapped: false,
      wrapContinuation: false,
      selection: null,
    })),
  };
}

function state(totalRows: number, revision: number, screen: 'normal' | 'alternate') {
  return {
    screen,
    totalRows,
    scrollbackRows: Math.max(0, totalRows - 2),
    viewportY: Math.max(0, totalRows - 2),
    viewportLength: Math.min(2, totalRows),
    cursorX: 0,
    cursorY: Math.min(1, totalRows - 1),
    revision,
  };
}

function plainCell(x: number, text: string): RenderCell {
  return {
    x,
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

import type { RenderCell, TerminalBufferState } from '@gespenst/core';
import { describe, expect, it, vi } from 'vitest';
import { BufferCell, BufferNamespace, BufferView, type PackedBufferRow } from '../src/buffer';

describe('xterm buffer views', () => {
  it('maps every stable cell attribute and translates visual columns', () => {
    const row = packedRow([
      styledCell(0, '😀', 'wide'),
      styledCell(1, '', 'spacer-tail'),
      styledCell(2, 'X', 'narrow'),
    ]);
    const view = new BufferView('normal', 5, 1);
    view.attach({
      state: () => ({ ...textSource([], 1).source.state(), viewportY: 0 }),
      rows: () => [row],
    });
    const line = view.getLine(0);
    const first = line?.getCell(0);
    const second = line?.getCell(2, first);

    expect(line?.length).toBe(5);
    expect(line?.isWrapped).toBe(true);
    expect(line?.translateToString()).toBe('😀X  ');
    expect(line?.translateToString(true, 0, 3)).toBe('😀X');
    expect(line?.getCell(-1)).toBeUndefined();
    expect(line?.getCell(5)).toBeUndefined();
    expect(line?.getCell(4)?.getWidth()).toBe(1);
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

  it('reads rows in blocks on first use and keeps them until they change', () => {
    const rows = textSource(['a', 'b', 'c', 'd'], 200);
    const view = new BufferView('normal', 4, 2);
    view.attach(rows.source);
    expect(rows.stateReads).toBe(0);
    expect(view.length).toBe(200);
    expect(view.baseY).toBe(198);

    expect(view.getLine(100)?.translateToString(true)).toBe('row 100');
    expect(view.getLine(70)?.translateToString(true)).toBe('row 70');
    expect(view.getLine(199)?.translateToString(true)).toBe('row 199');
    expect(rows.reads).toEqual([
      [64, 128],
      [192, 200],
    ]);
    expect(view.getLine(200)).toBeUndefined();
    expect(view.getLine(-1)).toBeUndefined();
    expect(view.getLine(1.5)).toBeUndefined();
  });

  it('shifts cached rows on trim and drops rows at or after the first dirty row', () => {
    const rows = textSource([], 200);
    const view = new BufferView('normal', 4, 2);
    view.attach(rows.source, rows.source.state());
    for (const y of [10, 100, 199]) view.getLine(y);
    expect(rows.reads).toHaveLength(3);

    rows.shift(3);
    view.apply({ state: rows.source.state(), trimmed: 3, reset: false, dirtyFrom: 150 });
    expect(view.getLine(7)?.translateToString(true)).toBe('row 10');
    expect(view.getLine(97)?.translateToString(true)).toBe('row 100');
    expect(rows.reads).toHaveLength(3);
    expect(view.getLine(196)?.translateToString(true)).toBe('row 199');
    expect(rows.reads).toHaveLength(4);

    view.apply({ state: rows.source.state(), trimmed: 0, reset: true, dirtyFrom: 0 });
    view.getLine(7);
    expect(rows.reads).toHaveLength(5);
  });

  it('serves blank rows without a source', () => {
    const view = new BufferView('alternate', 4, 3);
    expect(view.length).toBe(3);
    expect(view.cursorX).toBe(0);
    expect(view.viewportY).toBe(0);
    expect(view.getLine(2)?.translateToString()).toBe('    ');
    expect(view.getLine(2)?.getCell(1)?.getChars()).toBe('');
    view.resize(5, 4);
    expect(view.length).toBe(4);
    expect(view.getLine(3)?.translateToString()).toBe('     ');
  });

  it('switches screens and reads the normal screen while the alternate one is active', () => {
    const normal = textSource(['n0', 'n1', 'n2'], 3);
    const alternate = textSource(['a0', 'a1'], 2, 'alternate');
    let screen: 'normal' | 'alternate' = 'normal';
    const source = {
      state: () => (screen === 'normal' ? normal : alternate).source.state(),
      rows: (start: number, end: number) =>
        (screen === 'normal' ? normal : alternate).source.rows(start, end),
      normalState: () => normal.source.state(),
      normalRows: (start: number, end: number) => normal.source.rows(start, end),
    };
    const namespace = new BufferNamespace(4, 2);
    const changes = vi.fn();
    const subscription = namespace.onBufferChange(changes);
    const sync = (reset = false) =>
      namespace.sync(source, { state: source.state(), trimmed: 0, reset, dirtyFrom: 0 });

    sync(true);
    expect(changes).not.toHaveBeenCalled();
    expect(namespace.active.getLine(2)?.translateToString(true)).toBe('n2');

    screen = 'alternate';
    sync(true);
    expect(namespace.active.type).toBe('alternate');
    expect(changes).toHaveBeenCalledOnce();
    expect(namespace.active.getLine(0)?.translateToString(true)).toBe('a0');
    expect(namespace.normal.length).toBe(3);
    expect(namespace.normal.getLine(1)?.translateToString(true)).toBe('n1');

    screen = 'normal';
    sync();
    expect(namespace.active.type).toBe('normal');
    expect(changes).toHaveBeenCalledTimes(2);
    expect(namespace.alternate.length).toBe(2);
    expect(namespace.alternate.getLine(0)?.translateToString(true)).toBe('');
    expect(namespace.cellAt(0, 0)).toBeUndefined();
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

/** Packs cells the way core does, so the test exercises only the decoding. */
function packedRow(cells: readonly RenderCell[]): PackedBufferRow {
  const words = new Uint32Array(cells.length * 3);
  for (const cell of cells) {
    const packed = new BufferCell().load(cell) as unknown as {
      content: number;
      foreground: number;
      background: number;
    };
    words.set([packed.content, packed.foreground, packed.background], cell.x * 3);
  }
  return {
    index: 0,
    cells: words,
    strings: [],
    hyperlinks: [],
    wrapped: true,
    wrapContinuation: true,
  };
}

/** A screen whose rows read `row N` unless named, recording every range that is read. */
function textSource(
  names: readonly string[],
  totalRows: number,
  screen: 'normal' | 'alternate' = 'normal'
) {
  let first = 0;
  const reads: Array<[number, number]> = [];
  const result = {
    reads,
    stateReads: 0,
    shift(count: number) {
      first += count;
    },
    source: {
      state: (): TerminalBufferState => {
        result.stateReads += 1;
        return {
          screen,
          totalRows,
          scrollbackRows: Math.max(0, totalRows - 2),
          viewportY: Math.max(0, totalRows - 2),
          viewportLength: Math.min(2, totalRows),
          cursorX: 0,
          cursorY: 1,
          revision: 1,
        };
      },
      rows: (start: number, end: number): PackedBufferRow[] => {
        reads.push([start, end]);
        return Array.from({ length: end - start }, (_, offset) =>
          textRow(start + offset, names[start + offset] ?? `row ${first + start + offset}`)
        );
      },
    },
  };
  return result;
}

function textRow(index: number, text: string): PackedBufferRow {
  const cells = new Uint32Array(text.length * 3);
  for (let x = 0; x < text.length; x += 1) cells[x * 3] = (text.codePointAt(x) ?? 0) | (1 << 27);
  return { index, cells, strings: [], hyperlinks: [], wrapped: false, wrapContinuation: false };
}

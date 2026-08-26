import type { RenderCell, TerminalBufferRow } from '@gespenst/core';
import { describe, expect, it } from 'vitest';
import { BufferSearchScanner, compileSearchPattern } from '../src/matcher.js';

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
};

describe('buffer search matcher', () => {
  it('maps grapheme UTF-16 offsets and visual blanks back to terminal columns', () => {
    const scanner = new BufferSearchScanner(pattern('😀  b'), false);
    scanner.accept(
      row(4, [
        cell(0, 'a'),
        cell(1, '😀', 'wide'),
        cell(2, '', 'spacer-tail'),
        cell(3, ''),
        cell(4, ''),
        cell(5, 'b'),
      ])
    );

    expect(scanner.finish()[0]?.value).toEqual({
      text: '😀  b',
      start: { row: 4, column: 1 },
      end: { row: 4, column: 6 },
      segments: [{ row: 4, column: 1, length: 5 }],
    });
  });

  it('joins only mutually linked soft-wrapped rows', () => {
    const joined = new BufferSearchScanner(pattern('abcd'), false);
    joined.accept(row(0, [cell(0, 'a'), cell(1, 'b')], true));
    joined.accept(row(1, [cell(0, 'c'), cell(1, 'd')], false, true));
    expect(joined.finish()).toHaveLength(1);

    const hardBreak = new BufferSearchScanner(pattern('abcd'), false);
    hardBreak.accept(row(0, [cell(0, 'a'), cell(1, 'b')]));
    hardBreak.accept(row(1, [cell(0, 'c'), cell(1, 'd')]));
    expect(hardBreak.finish()).toHaveLength(0);
  });

  it('uses Unicode word boundaries and ignores empty regex matches', () => {
    const words = new BufferSearchScanner(pattern('猫', { wholeWord: true }), true);
    words.accept(row(0, cells('猫 猫名')));
    expect(words.finish()).toHaveLength(1);

    const empty = new BufferSearchScanner(pattern('^|$', { regex: true }), false);
    empty.accept(row(0, cells('text')));
    expect(empty.finish()).toHaveLength(0);
  });
});

function pattern(
  query: string,
  options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {}
): RegExp {
  return compileSearchPattern(query, {
    caseSensitive: options.caseSensitive ?? false,
    wholeWord: options.wholeWord ?? false,
    regex: options.regex ?? false,
  });
}

function row(
  index: number,
  values: readonly RenderCell[],
  wrapped = false,
  wrapContinuation = false
): TerminalBufferRow {
  return {
    index,
    id: `row-${index}`,
    text: values
      .map((value) => value.text || ' ')
      .join('')
      .trimEnd(),
    cells: values,
    wrapped,
    wrapContinuation,
    selection: null,
  };
}

function cells(text: string): readonly RenderCell[] {
  return [...text].map((value, index) => cell(index, value));
}

function cell(x: number, text: string, width: RenderCell['width'] = 'narrow'): RenderCell {
  return {
    x,
    text,
    width,
    style,
    foreground: null,
    background: null,
    hyperlink: false,
    semanticContent: 'unknown',
  };
}

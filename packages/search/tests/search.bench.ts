import type { RenderCell, TerminalBufferRow } from '@gespenst/core';
import { bench } from 'vitest';
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
const rows = Array.from({ length: 10_000 }, (_, index) => benchmarkRow(index));

bench('searches 10,000 retained rows', () => {
  const scanner = new BufferSearchScanner(
    compileSearchPattern('needle', { caseSensitive: false, wholeWord: false, regex: false }),
    false
  );
  for (const row of rows) scanner.accept(row);
  scanner.finish();
});

function benchmarkRow(index: number): TerminalBufferRow {
  const text =
    index % 100 === 0 ? `line ${index} contains needle` : `ordinary terminal line ${index}`;
  return {
    index,
    id: `row-${index}`,
    text,
    cells: [...text].map(
      (value, x): RenderCell => ({
        x,
        text: value,
        width: 'narrow',
        style,
        foreground: null,
        background: null,
        hyperlink: false,
        semanticContent: 'unknown',
      })
    ),
    wrapped: false,
    wrapContinuation: false,
    selection: null,
  };
}

import type { RenderCell, TerminalBufferRow } from '@gespenst/core';
import type { SearchMatch, SearchMatchSegment, SearchOptions } from './index.js';

interface TextCellSpan {
  readonly start: number;
  readonly end: number;
  readonly row: number;
  readonly rowId: string;
  readonly column: number;
  readonly length: number;
}

interface LogicalLine {
  text: string;
  spans: TextCellSpan[];
  previousWrapped: boolean;
}

export interface IndexedSearchMatch {
  readonly value: SearchMatch;
  readonly identity: string;
}

/** Incrementally searches logical terminal lines while pages are released by the caller. */
export class BufferSearchScanner {
  private line: LogicalLine | null = null;
  private readonly matches: IndexedSearchMatch[] = [];
  private readonly pattern: RegExp;
  private readonly wholeWord: boolean;

  constructor(pattern: RegExp, wholeWord: boolean) {
    this.pattern = pattern;
    this.wholeWord = wholeWord;
  }

  accept(row: TerminalBufferRow): void {
    const continues = Boolean(this.line?.previousWrapped && row.wrapContinuation);
    if (this.line && !continues) this.flush();
    this.line ??= { text: '', spans: [], previousWrapped: false };
    appendRow(this.line, row);
    this.line.previousWrapped = row.wrapped;
    if (!row.wrapped) this.flush();
  }

  finish(): readonly IndexedSearchMatch[] {
    this.flush();
    return this.matches;
  }

  private flush(): void {
    const line = this.line;
    this.line = null;
    if (!line || !line.text) return;
    this.pattern.lastIndex = 0;
    for (const match of line.text.matchAll(this.pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      const start = match.index;
      const end = start + match[0].length;
      if (this.wholeWord && !hasWordBoundaries(line.text, start, end)) continue;
      const segments = segmentsForRange(line.spans, start, end);
      const first = segments[0];
      const last = segments.at(-1);
      if (!first || !last) continue;
      const value: SearchMatch = {
        text: match[0],
        start: { row: first.row, column: first.column },
        end: { row: last.row, column: last.column + last.length },
        segments,
      };
      const covered = line.spans.filter((span) => span.end > start && span.start < end);
      this.matches.push({
        value,
        identity: JSON.stringify([
          covered[0]?.rowId ?? '',
          first.column,
          covered.at(-1)?.rowId ?? '',
          last.column + last.length,
          match[0],
        ]),
      });
    }
  }
}

export function compileSearchPattern(query: string, options: Required<SearchOptions>): RegExp {
  const source = options.regex ? query : escapeRegExp(query);
  return new RegExp(source, options.caseSensitive ? 'gu' : 'giu');
}

function appendRow(line: LogicalLine, row: TerminalBufferRow): void {
  for (const cell of searchableCells(row.cells, row.wrapped)) {
    const text = cell.text || ' ';
    const start = line.text.length;
    line.text += text;
    line.spans.push({
      start,
      end: line.text.length,
      row: row.index,
      rowId: row.id,
      column: cell.x,
      length: cell.width === 'wide' ? 2 : 1,
    });
  }
}

function searchableCells(cells: readonly RenderCell[], wrapped: boolean): readonly RenderCell[] {
  const values = cells.filter(
    (cell) => cell.width !== 'spacer-head' && cell.width !== 'spacer-tail'
  );
  if (wrapped) return values;
  let end = values.length;
  while (end > 0 && !values[end - 1]?.text) end -= 1;
  return values.slice(0, end);
}

function segmentsForRange(
  spans: readonly TextCellSpan[],
  start: number,
  end: number
): readonly SearchMatchSegment[] {
  const result: SearchMatchSegment[] = [];
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    const previous = result.at(-1);
    if (
      previous &&
      previous.row === span.row &&
      previous.column + previous.length === span.column
    ) {
      result[result.length - 1] = { ...previous, length: previous.length + span.length };
    } else {
      result.push({ row: span.row, column: span.column, length: span.length });
    }
  }
  return result;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}\p{Pc}]/u;

function hasWordBoundaries(text: string, start: number, end: number): boolean {
  const before = start === 0 ? '' : codePointBefore(text, start);
  const after = end >= text.length ? '' : String.fromCodePoint(text.codePointAt(end) ?? 0);
  return (!before || !WORD_CHARACTER.test(before)) && (!after || !WORD_CHARACTER.test(after));
}

function codePointBefore(text: string, index: number): string {
  const trailing = text.charCodeAt(index - 1);
  if (trailing >= 0xdc00 && trailing <= 0xdfff && index > 1) return text.slice(index - 2, index);
  return text[index - 1] ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

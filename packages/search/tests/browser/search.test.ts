import type {
  BrowserTerminal,
  BrowserTerminalEventMap,
  Disposable,
  RenderCell,
  TerminalBufferRange,
  TerminalBufferRow,
  TerminalBufferSnapshot,
  TerminalBufferState,
} from '@gespenst/core';
import { createTerminal } from '@gespenst/core';
import { describe, expect, it } from 'vitest';
import { SearchAddon, type SearchResult } from '../../src';

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

describe('@gespenst/search', () => {
  it('pages the complete buffer and maps a match across a soft wrap', async () => {
    const terminal = new FakeTerminal(
      [
        row(0, 'old'),
        row(1, 'ab😀', { wrapped: true, cells: wideCells('ab😀') }),
        row(2, 'tar', { wrapContinuation: true }),
        row(3, 'new'),
      ],
      2,
      2,
      4
    );
    const addon = new SearchAddon({ pageSize: 1 });
    addon.activate(terminal.value);
    const results: SearchResult[] = [];
    addon.onDidChangeResults((result) => results.push(result));

    expect(await addon.findNext('😀tar')).toBe(true);
    expect(results.at(-1)).toMatchObject({ status: 'complete', matchCount: 1, activeIndex: 0 });
    expect(addon.getMatch(0)).toEqual({
      text: '😀tar',
      start: { row: 1, column: 2 },
      end: { row: 2, column: 3 },
      segments: [
        { row: 1, column: 2, length: 2 },
        { row: 2, column: 0, length: 3 },
      ],
    });
    expect(terminal.reads).toEqual([
      { start: 0, end: 0 },
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 0, end: 1 },
    ]);
    addon.dispose();
    terminal.dispose();
  });

  it('navigates from the viewport, wraps, and scrolls off-screen matches into view', async () => {
    const terminal = new FakeTerminal(
      [
        row(0, 'target'),
        row(1, 'one'),
        row(2, 'two'),
        row(3, 'target'),
        row(4, 'four'),
        row(5, 'five'),
        row(6, 'target'),
      ],
      5,
      2,
      8
    );
    const addon = new SearchAddon();
    addon.activate(terminal.value);
    const results: SearchResult[] = [];
    addon.onDidChangeResults((result) => results.push(result));

    expect(await addon.findNext('target')).toBe(true);
    expect(results.at(-1)).toMatchObject({ matchCount: 3, activeIndex: 2 });
    expect(results.at(-1)?.activeMatch?.start.row).toBe(6);
    expect(await addon.findNext('target')).toBe(true);
    expect(results.at(-1)?.activeIndex).toBe(0);
    expect(terminal.scrollDeltas).toEqual([-5]);
    expect(await addon.findPrevious('target')).toBe(true);
    expect(results.at(-1)?.activeIndex).toBe(2);
    expect(terminal.scrollDeltas).toEqual([-5, 5]);

    addon.dispose();
    terminal.dispose();
  });

  it('supports blank cells, Unicode whole words, regexes, errors, and hard-line boundaries', async () => {
    const terminal = new FakeTerminal(
      [
        row(0, 'a  target', { cells: textCells('a  target', true) }),
        row(1, '猫 scatter cat Cat'),
        row(2, 'hard'),
        row(3, 'break'),
      ],
      0,
      4,
      20
    );
    const addon = new SearchAddon();
    addon.activate(terminal.value);
    const results: SearchResult[] = [];
    addon.onDidChangeResults((result) => results.push(result));

    expect(await addon.findNext('target')).toBe(true);
    expect(addon.getMatch(0)?.start).toEqual({ row: 0, column: 3 });
    expect(await addon.findNext('猫', { wholeWord: true })).toBe(true);
    expect(results.at(-1)?.matchCount).toBe(1);
    expect(await addon.findNext('cat', { wholeWord: true, caseSensitive: true })).toBe(true);
    expect(results.at(-1)?.matchCount).toBe(1);
    expect(await addon.findNext('C.t', { regex: true })).toBe(true);
    expect(results.at(-1)?.matchCount).toBe(3);
    expect(await addon.findNext('hardbreak')).toBe(false);
    expect(results.at(-1)).toMatchObject({ status: 'complete', matchCount: 0 });
    expect(await addon.findNext('[', { regex: true })).toBe(false);
    expect(results.at(-1)?.status).toBe('error');
    expect(results.at(-1)?.error).toContain('regular expression');
    expect(await addon.findNext('')).toBe(false);
    expect(results.at(-1)).toMatchObject({ status: 'idle', query: '', activeIndex: -1 });

    addon.dispose();
    terminal.dispose();
  });

  it('preserves an active row identity across trimming and redraws without rescanning on scroll', async () => {
    const terminal = new FakeTerminal(
      [row(0, 'target', { id: 'trimmed' }), row(1, 'target', { id: 'survivor' }), row(2, 'end')],
      0,
      2,
      8
    );
    const addon = new SearchAddon({ refreshDebounceMs: 0 });
    addon.activate(terminal.value);
    const results: SearchResult[] = [];
    addon.onDidChangeResults((result) => results.push(result));
    await addon.findNext('target');
    await addon.findNext('target');
    expect(results.at(-1)?.activeMatch?.start.row).toBe(1);

    terminal.replaceRows([row(0, 'target', { id: 'survivor' }), row(1, 'new')]);
    terminal.emit('bufferChange', { reason: 'write' });
    expect(addon.getMatch(0)).toBeUndefined();
    await waitFor(() => results.at(-1)?.status === 'complete' && results.at(-1)?.matchCount === 1);
    expect(results.at(-1)?.activeIndex).toBe(0);
    expect(results.at(-1)?.activeMatch?.start.row).toBe(0);

    const reads = terminal.reads.length;
    terminal.setViewport(0);
    terminal.emitViewport();
    expect(terminal.reads).toHaveLength(reads);

    addon.dispose();
    expect(terminal.element.querySelector('.gespenst__search-layer')).toBeNull();
    expect(terminal.listenerCount).toBe(0);
    terminal.dispose();
  });

  it('uses one device-pixel canvas and validates performance options', async () => {
    expect(() => new SearchAddon({ pageSize: 0 })).toThrow(RangeError);
    expect(() => new SearchAddon({ refreshDebounceMs: -1 })).toThrow(RangeError);
    const terminal = new FakeTerminal([row(0, 'target target')], 0, 1, 20);
    terminal.element.style.setProperty('--gespenst-search-match-background', '#ff000080');
    const addon = new SearchAddon();
    addon.activate(terminal.value);
    await addon.findNext('target');

    const canvases =
      terminal.element.querySelectorAll<HTMLCanvasElement>('.gespenst__search-layer');
    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.width).toBe(200);
    expect(canvases[0]?.height).toBe(20);
    const pixels = canvases[0]?.getContext('2d')?.getImageData(0, 0, 200, 20).data;
    expect(pixels && [...pixels].some((value) => value !== 0)).toBe(true);

    addon.dispose();
    terminal.dispose();
  });

  it('finds and reveals retained scrollback through the real Ghostty buffer', async () => {
    const host = document.createElement('div');
    host.style.width = '200px';
    host.style.height = '80px';
    document.body.append(host);
    const terminal = await createTerminal({
      container: host,
      worker: false,
      renderer: 'canvas2d',
      cols: 12,
      rows: 2,
      scrollbackLines: 20,
    });
    const addon = new SearchAddon({ pageSize: 2 });
    terminal.loadAddon(addon);
    await terminal.writeAsync('needle\r\none\r\ntwo\r\nthree\r\nfour');
    expect((await terminal.readBuffer()).state.viewportY).toBeGreaterThan(0);

    expect(await addon.findNext('needle')).toBe(true);
    expect(addon.getMatch(0)?.start).toMatchObject({ row: 0, column: 0 });
    expect((await terminal.readBuffer()).state.viewportY).toBe(0);
    expect(terminal.element.querySelectorAll('.gespenst__search-layer')).toHaveLength(1);

    terminal.dispose();
    host.remove();
  });
});

class FakeTerminal {
  readonly element = document.createElement('div');
  readonly geometry = {
    cols: 20,
    rows: 2,
    cellWidthPx: 10,
    cellHeightPx: 20,
    widthPx: 200,
    heightPx: 40,
  };
  readonly reads: TerminalBufferRange[] = [];
  readonly scrollDeltas: number[] = [];
  private rows: TerminalBufferRow[];
  private viewportY: number;
  private readonly listeners = new Map<
    keyof BrowserTerminalEventMap,
    Set<(value: never) => void>
  >();

  constructor(rows: TerminalBufferRow[], viewportY: number, viewportLength: number, cols: number) {
    this.rows = rows;
    this.viewportY = viewportY;
    this.geometry = {
      cols,
      rows: viewportLength,
      cellWidthPx: 10,
      cellHeightPx: 20,
      widthPx: cols * 10,
      heightPx: viewportLength * 20,
    };
    this.element.style.position = 'relative';
    document.body.append(this.element);
  }

  get value(): BrowserTerminal {
    return {
      element: this.element,
      geometry: this.geometry,
      readBuffer: (range?: TerminalBufferRange) => this.readBuffer(range),
      scrollLines: (delta: number) => this.scrollLines(delta),
      on: <Key extends keyof BrowserTerminalEventMap>(
        type: Key,
        listener: (value: BrowserTerminalEventMap[Key]) => void
      ) => this.on(type, listener),
    } as unknown as BrowserTerminal;
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }

  replaceRows(rows: TerminalBufferRow[]): void {
    this.rows = rows;
    this.viewportY = Math.min(this.viewportY, this.state.scrollbackRows);
  }

  setViewport(value: number): void {
    this.viewportY = value;
  }

  emitViewport(): void {
    const state = this.state;
    this.emit('viewportChange', { revision: state.revision, state });
  }

  emit<Key extends keyof BrowserTerminalEventMap>(
    type: Key,
    value: BrowserTerminalEventMap[Key]
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(value as never);
  }

  dispose(): void {
    this.element.remove();
  }

  private get state(): TerminalBufferState {
    const viewportLength = this.geometry.rows;
    return {
      screen: 'normal',
      totalRows: this.rows.length,
      scrollbackRows: Math.max(0, this.rows.length - viewportLength),
      viewportY: this.viewportY,
      viewportLength,
      cursorX: 0,
      cursorY: 0,
      revision: 1,
    };
  }

  private async readBuffer(range?: TerminalBufferRange): Promise<TerminalBufferSnapshot> {
    const actual = range ?? {
      start: this.viewportY,
      end: this.viewportY + this.geometry.rows,
    };
    this.reads.push(actual);
    return { state: this.state, rows: this.rows.slice(actual.start, actual.end) };
  }

  private scrollLines(delta: number): void {
    this.scrollDeltas.push(delta);
    this.viewportY = Math.max(0, Math.min(this.state.scrollbackRows, this.viewportY + delta));
    this.emitViewport();
  }

  private on<Key extends keyof BrowserTerminalEventMap>(
    type: Key,
    listener: (value: BrowserTerminalEventMap[Key]) => void
  ): Disposable {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (value: never) => void);
    this.listeners.set(type, listeners);
    return { dispose: () => listeners.delete(listener as (value: never) => void) };
  }
}

function row(
  index: number,
  text: string,
  options: {
    id?: string;
    wrapped?: boolean;
    wrapContinuation?: boolean;
    cells?: readonly RenderCell[];
  } = {}
): TerminalBufferRow {
  return {
    index,
    id: options.id ?? `row-${index}`,
    text,
    cells: options.cells ?? textCells(text),
    wrapped: options.wrapped ?? false,
    wrapContinuation: options.wrapContinuation ?? false,
    selection: null,
  };
}

function textCells(text: string, blankAsEmpty = false): readonly RenderCell[] {
  return [...text].map((value, x) => cell(x, blankAsEmpty && value === ' ' ? '' : value));
}

function wideCells(text: string): readonly RenderCell[] {
  const values = [...text];
  return [
    cell(0, values[0] ?? ''),
    cell(1, values[1] ?? ''),
    cell(2, '😀', 'wide'),
    cell(3, '', 'spacer-tail'),
  ];
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for search refresh');
}

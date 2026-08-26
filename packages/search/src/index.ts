import type {
  BrowserTerminal,
  Disposable,
  TerminalAddon,
  TerminalBufferState,
  TerminalViewportChangeEvent,
} from '@gespenst/core';
import { BufferSearchScanner, compileSearchPattern, type IndexedSearchMatch } from './matcher.js';

/** Controls how retained terminal text is matched. */
export interface SearchOptions {
  /** Match uppercase and lowercase characters separately. */
  readonly caseSensitive?: boolean;
  /** Only accept matches surrounded by Unicode word boundaries. */
  readonly wholeWord?: boolean;
  /** Interpret the query as a regular expression instead of literal text. */
  readonly regex?: boolean;
}

/** Performance policy for full-buffer searches. */
export interface SearchAddonOptions {
  /** Rows requested from Ghostty at once. @defaultValue `256` */
  readonly pageSize?: number;
  /** Delay before rescanning after terminal output changes. @defaultValue `150` milliseconds. */
  readonly refreshDebounceMs?: number;
}

/** An absolute terminal-buffer coordinate. */
export interface SearchPoint {
  /** Zero-based row measured from the oldest retained row. */
  readonly row: number;
  /** Zero-based terminal cell column. */
  readonly column: number;
}

/** Cells covered by a match on one physical terminal row. */
export interface SearchMatchSegment extends SearchPoint {
  /** Number of terminal cells covered on this row. */
  readonly length: number;
}

/** A match in absolute retained-buffer coordinates. */
export interface SearchMatch {
  /** Exact text matched by the literal or regular expression. */
  readonly text: string;
  /** First covered cell. */
  readonly start: SearchPoint;
  /** Exclusive end coordinate on the last covered row. */
  readonly end: SearchPoint;
  /** Physical-row spans, including matches crossing soft wraps. */
  readonly segments: readonly SearchMatchSegment[];
}

/** Lifecycle of the current asynchronous search. */
export type SearchStatus = 'idle' | 'searching' | 'complete' | 'error';

/** Search summary and active match without an unbounded public result array. */
export interface SearchResult {
  /** Current search lifecycle. */
  readonly status: SearchStatus;
  /** Query represented by this result. */
  readonly query: string;
  /** Fully normalized options represented by this result. */
  readonly options: Readonly<Required<SearchOptions>>;
  /** Total matches after completion, or `null` while searching. */
  readonly matchCount: number | null;
  /** Zero-based active match index, or `-1`. */
  readonly activeIndex: number;
  /** Materialized active match, or `null`. */
  readonly activeMatch: SearchMatch | null;
  /** Validation or buffer-read failure, or `null`. */
  readonly error: string | null;
}

const DEFAULT_SEARCH_OPTIONS: Required<SearchOptions> = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/** Searches the complete retained Ghostty buffer and renders visible matches on one canvas. */
export class SearchAddon implements TerminalAddon {
  private terminal: BrowserTerminal | null = null;
  private readonly listeners = new Set<(result: SearchResult) => void>();
  private readonly subscriptions: Disposable[] = [];
  private readonly pageSize: number;
  private readonly refreshDebounceMs: number;
  private result: SearchResult = idleResult();
  private matches: readonly IndexedSearchMatch[] = [];
  private matchesByRow = new Map<number, Array<{ match: number; segment: number }>>();
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private bufferState: TerminalBufferState | null = null;
  private query = '';
  private options: Required<SearchOptions> = { ...DEFAULT_SEARCH_OPTIONS };
  private generation = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingReveals = new Set<() => void>();
  private indexStale = false;

  constructor(options: SearchAddonOptions = {}) {
    this.pageSize = integerOption('pageSize', options.pageSize ?? 256, 1, 4096);
    this.refreshDebounceMs = numberOption(
      'refreshDebounceMs',
      options.refreshDebounceMs ?? 150,
      0,
      60_000
    );
  }

  /** Attaches the addon to a terminal. Called by `terminal.loadAddon()`. */
  activate(terminal: BrowserTerminal): void {
    if (this.terminal) throw new Error('SearchAddon is already active');
    this.terminal = terminal;
    const canvas = terminal.element.ownerDocument.createElement('canvas');
    canvas.className = 'gespenst__search-layer';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3';
    terminal.element.append(canvas);
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.resizeCanvas();
    this.subscriptions.push(
      terminal.on('bufferChange', () => {
        this.indexStale = true;
        this.clearCanvas();
        this.queueRefresh();
      }),
      terminal.on('viewportChange', (event) => this.handleViewport(event)),
      terminal.on('resize', () => {
        this.resizeCanvas();
        this.renderHighlights();
      }),
      terminal.on('font', () => this.renderHighlights())
    );
  }

  /** Selects the next match in retained-buffer order, wrapping after the final match. */
  async findNext(query: string, options: SearchOptions = {}): Promise<boolean> {
    return this.search(query, options, 1);
  }

  /** Selects the previous match in retained-buffer order, wrapping before the first match. */
  async findPrevious(query: string, options: SearchOptions = {}): Promise<boolean> {
    return this.search(query, options, -1);
  }

  /** Materializes one completed match without exposing an unbounded result array. */
  getMatch(index: number): SearchMatch | undefined {
    if (this.indexStale || this.result.status !== 'complete' || !Number.isInteger(index)) {
      return undefined;
    }
    return this.matches[index]?.value;
  }

  /** Clears query, indexed matches, active navigation, and highlights. */
  clear(): void {
    this.generation += 1;
    this.cancelReveals();
    this.cancelRefresh();
    this.query = '';
    this.options = { ...DEFAULT_SEARCH_OPTIONS };
    this.matches = [];
    this.matchesByRow.clear();
    this.indexStale = false;
    this.result = idleResult();
    this.clearCanvas();
    this.emit();
  }

  /** Subscribes to search lifecycle and active-match changes. */
  onDidChangeResults(listener: (result: SearchResult) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Removes the overlay and releases pending work and event subscriptions. */
  dispose(): void {
    this.generation += 1;
    this.cancelReveals();
    this.cancelRefresh();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.canvas?.remove();
    this.canvas = null;
    this.context = null;
    this.matches = [];
    this.matchesByRow.clear();
    this.listeners.clear();
    this.terminal = null;
  }

  private async search(query: string, options: SearchOptions, direction: 1 | -1): Promise<boolean> {
    const terminal = this.terminal;
    if (!terminal || !query) {
      this.clear();
      return false;
    }
    const normalized = normalizeOptions(options);
    const sameSearch =
      !this.indexStale &&
      this.result.status === 'complete' &&
      query === this.query &&
      sameOptions(normalized, this.options);
    if (!sameSearch) {
      this.cancelRefresh();
      this.query = query;
      this.options = normalized;
      if (!(await this.buildIndex(null, false))) return false;
    }
    if (this.matches.length === 0) return false;
    const previous = sameSearch ? this.result.activeIndex : -1;
    const activeIndex =
      previous >= 0
        ? (previous + direction + this.matches.length) % this.matches.length
        : initialMatchIndex(this.matches, this.bufferState, direction);
    this.publishComplete(activeIndex);
    await this.revealActive(this.generation);
    return this.terminal === terminal && this.result.activeIndex === activeIndex;
  }

  private async buildIndex(
    preserveIdentity: string | null,
    publishResult = true
  ): Promise<boolean> {
    const terminal = this.terminal;
    if (!terminal || !this.query) return false;
    this.cancelReveals();
    const generation = ++this.generation;
    this.result = {
      status: 'searching',
      query: this.query,
      options: this.options,
      matchCount: null,
      activeIndex: -1,
      activeMatch: null,
      error: null,
    };
    this.indexStale = true;
    this.clearCanvas();
    this.emit();
    let pattern: RegExp;
    try {
      pattern = compileSearchPattern(this.query, this.options);
    } catch (error) {
      if (generation !== this.generation) return false;
      this.publishError(error);
      return false;
    }
    try {
      const indexed = await this.scanBuffer(terminal, pattern, generation, 0);
      if (!indexed || generation !== this.generation || this.terminal !== terminal) return false;
      this.matches = indexed.matches;
      this.bufferState = indexed.state;
      this.indexRows();
      this.indexStale = false;
      const activeIndex = preserveIdentity
        ? this.matches.findIndex((match) => match.identity === preserveIdentity)
        : -1;
      if (publishResult || this.matches.length === 0) this.publishComplete(activeIndex);
      return true;
    } catch (error) {
      if (generation !== this.generation || this.terminal !== terminal) return false;
      this.publishError(error);
      return false;
    }
  }

  private async scanBuffer(
    terminal: BrowserTerminal,
    pattern: RegExp,
    generation: number,
    attempt: number
  ): Promise<{ matches: readonly IndexedSearchMatch[]; state: TerminalBufferState } | null> {
    const initial = await terminal.readBuffer({ start: 0, end: 0 });
    if (generation !== this.generation) return null;
    const totalRows = initial.state.totalRows;
    const screen = initial.state.screen;
    const scanner = new BufferSearchScanner(pattern, this.options.wholeWord);
    let state = initial.state;
    let oldestId: string | null = null;
    let sliceStarted = performance.now();
    for (let start = 0; start < totalRows; start += this.pageSize) {
      const page = await terminal.readBuffer({
        start,
        end: Math.min(totalRows, start + this.pageSize),
      });
      if (generation !== this.generation || this.terminal !== terminal) return null;
      state = page.state;
      if (state.screen !== screen) {
        if (attempt === 0) return this.scanBuffer(terminal, pattern, generation, 1);
        this.queueRefresh();
        return { matches: scanner.finish(), state };
      }
      if (start === 0) oldestId = page.rows[0]?.id ?? null;
      for (const row of page.rows) scanner.accept(row);
      if (performance.now() - sliceStarted >= 8) {
        await yieldToBrowser();
        sliceStarted = performance.now();
      }
    }
    if (totalRows > 0) {
      const sentinel = await terminal.readBuffer({ start: 0, end: 1 });
      if (generation !== this.generation || this.terminal !== terminal) return null;
      if (sentinel.state.screen !== screen || (sentinel.rows[0]?.id ?? null) !== oldestId) {
        if (attempt === 0) return this.scanBuffer(terminal, pattern, generation, 1);
        this.queueRefresh();
        return { matches: scanner.finish(), state: sentinel.state };
      }
      state = sentinel.state;
    }
    return { matches: scanner.finish(), state };
  }

  private queueRefresh(): void {
    if (!this.query || !this.terminal) return;
    this.cancelRefresh();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const activeIdentity = this.matches[this.result.activeIndex]?.identity ?? null;
      void this.buildIndex(activeIdentity);
    }, this.refreshDebounceMs);
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private handleViewport(event: TerminalViewportChangeEvent): void {
    this.bufferState = event.state;
    this.renderHighlights();
  }

  private publishComplete(activeIndex: number): void {
    const safeIndex = activeIndex >= 0 && activeIndex < this.matches.length ? activeIndex : -1;
    this.result = {
      status: 'complete',
      query: this.query,
      options: this.options,
      matchCount: this.matches.length,
      activeIndex: safeIndex,
      activeMatch: safeIndex < 0 ? null : (this.matches[safeIndex]?.value ?? null),
      error: null,
    };
    this.renderHighlights();
    this.emit();
  }

  private publishError(error: unknown): void {
    this.matches = [];
    this.matchesByRow.clear();
    this.indexStale = false;
    this.result = {
      status: 'error',
      query: this.query,
      options: this.options,
      matchCount: 0,
      activeIndex: -1,
      activeMatch: null,
      error: error instanceof Error ? error.message : String(error),
    };
    this.clearCanvas();
    this.emit();
  }

  private indexRows(): void {
    this.matchesByRow.clear();
    this.matches.forEach((match, matchIndex) => {
      match.value.segments.forEach((segment, segmentIndex) => {
        const entries = this.matchesByRow.get(segment.row) ?? [];
        entries.push({ match: matchIndex, segment: segmentIndex });
        this.matchesByRow.set(segment.row, entries);
      });
    });
  }

  private async revealActive(generation: number): Promise<void> {
    const terminal = this.terminal;
    const active = this.matches[this.result.activeIndex]?.value;
    const state = this.bufferState;
    if (!terminal || !active || !state) return;
    const first = active.start.row;
    const last = active.end.row;
    const viewportEnd = state.viewportY + state.viewportLength - 1;
    if (first >= state.viewportY && last <= viewportEnd) {
      this.renderHighlights();
      return;
    }
    const span = last - first + 1;
    const desired = Math.max(
      0,
      Math.min(
        state.scrollbackRows,
        span <= state.viewportLength
          ? Math.floor((first + last - state.viewportLength + 1) / 2)
          : first
      )
    );
    if (desired === state.viewportY) return;
    await new Promise<void>((resolve) => {
      let subscription: Disposable | null = null;
      const finish = () => {
        subscription?.dispose();
        this.pendingReveals.delete(finish);
        resolve();
      };
      this.pendingReveals.add(finish);
      subscription = terminal.on('viewportChange', ({ state: next }) => {
        if (next.viewportY !== desired) return;
        finish();
      });
      terminal.scrollLines(desired - state.viewportY);
      if (this.bufferState?.viewportY === desired) finish();
    });
    if (generation === this.generation) this.renderHighlights();
  }

  private resizeCanvas(): void {
    const terminal = this.terminal;
    const canvas = this.canvas;
    if (!terminal || !canvas) return;
    if (canvas.width !== terminal.geometry.widthPx) canvas.width = terminal.geometry.widthPx;
    if (canvas.height !== terminal.geometry.heightPx) canvas.height = terminal.geometry.heightPx;
  }

  private renderHighlights(): void {
    const terminal = this.terminal;
    const context = this.context;
    const state = this.bufferState;
    if (!terminal || !context || !state || this.indexStale) return;
    this.resizeCanvas();
    this.clearCanvas();
    const computed = terminal.element.ownerDocument.defaultView?.getComputedStyle(terminal.element);
    const normal =
      computed?.getPropertyValue('--gespenst-search-match-background').trim() ||
      'rgb(255 235 59 / 35%)';
    const active =
      computed?.getPropertyValue('--gespenst-search-active-match-background').trim() ||
      'rgb(255 179 0 / 55%)';
    const firstRow = state.viewportY;
    const endRow = firstRow + state.viewportLength;
    context.fillStyle = normal;
    for (let row = firstRow; row < endRow; row += 1) {
      for (const entry of this.matchesByRow.get(row) ?? []) {
        if (entry.match === this.result.activeIndex) continue;
        const segment = this.matches[entry.match]?.value.segments[entry.segment];
        if (segment) this.drawSegment(context, segment, firstRow);
      }
    }
    const selected = this.matches[this.result.activeIndex]?.value;
    if (selected) {
      context.fillStyle = active;
      for (const segment of selected.segments) {
        if (segment.row >= firstRow && segment.row < endRow) {
          this.drawSegment(context, segment, firstRow);
        }
      }
    }
  }

  private drawSegment(
    context: CanvasRenderingContext2D,
    segment: SearchMatchSegment,
    viewportY: number
  ): void {
    const geometry = this.terminal?.geometry;
    if (!geometry) return;
    context.fillRect(
      segment.column * geometry.cellWidthPx,
      (segment.row - viewportY) * geometry.cellHeightPx,
      segment.length * geometry.cellWidthPx,
      geometry.cellHeightPx
    );
  }

  private clearCanvas(): void {
    if (this.canvas && this.context)
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private cancelReveals(): void {
    for (const resolve of [...this.pendingReveals]) resolve();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.result);
  }
}

function idleResult(): SearchResult {
  return {
    status: 'idle',
    query: '',
    options: { ...DEFAULT_SEARCH_OPTIONS },
    matchCount: 0,
    activeIndex: -1,
    activeMatch: null,
    error: null,
  };
}

function normalizeOptions(options: SearchOptions): Required<SearchOptions> {
  return {
    caseSensitive: Boolean(options.caseSensitive),
    wholeWord: Boolean(options.wholeWord),
    regex: Boolean(options.regex),
  };
}

function sameOptions(left: Required<SearchOptions>, right: Required<SearchOptions>): boolean {
  return (
    left.caseSensitive === right.caseSensitive &&
    left.wholeWord === right.wholeWord &&
    left.regex === right.regex
  );
}

function initialMatchIndex(
  matches: readonly IndexedSearchMatch[],
  state: TerminalBufferState | null,
  direction: 1 | -1
): number {
  if (!state) return direction === 1 ? 0 : matches.length - 1;
  if (direction === 1) {
    const index = matches.findIndex((match) => match.value.end.row >= state.viewportY);
    return index < 0 ? 0 : index;
  }
  const bottom = state.viewportY + state.viewportLength - 1;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if ((matches[index]?.value.start.row ?? Number.POSITIVE_INFINITY) <= bottom) return index;
  }
  return matches.length - 1;
}

function integerOption(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function numberOption(name: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be from ${min} through ${max}`);
  }
  return value;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

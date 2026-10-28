import type { InputSource, TerminalBufferState } from '../core/types.js';

/** Runtime-only bridge key shared with `@gespenst/xterm` without expanding the public API. */
export const XTERM_COMPATIBILITY_BRIDGE = Symbol.for('@gespenst/core/xterm-compatibility');

/** Three packed 32-bit words are used for every xterm-compatible cell. @internal */
export const XTERM_CELL_WORDS = 3 as const;

/** A sparse string associated with a packed cell column. @internal */
export type XtermCompatibilityString = readonly [column: number, value: string];

/** One packed row positioned in the retained active buffer. @internal */
export interface XtermCompatibilityRow {
  readonly index: number;
  readonly cells: Uint32Array;
  readonly strings: readonly XtermCompatibilityString[];
  readonly hyperlinks: readonly XtermCompatibilityString[];
  readonly wrapped: boolean;
  readonly wrapContinuation: boolean;
}

/** How the retained rows changed since a reader last asked. @internal */
export interface RetainedRowChanges {
  readonly state: TerminalBufferState;
  /** Rows pruned from the top of history; every older index moved up by this many rows. */
  readonly trimmed: number;
  /** Row identity was lost, for example after a resize, reset, restore, or screen switch. */
  readonly reset: boolean;
  /** First index whose content may have changed; rows before it are unchanged. */
  readonly dirtyFrom: number;
}

/**
 * Synchronous access to the retained rows of a terminal that runs on the main thread.
 * @internal
 */
export interface XtermBufferSource {
  /** Parses output synchronously and schedules the frame that paints it. */
  write(data: Uint8Array): void;
  /** Active-screen metadata. */
  state(): TerminalBufferState;
  /** Active-screen rows in `[start, end)`. */
  rows(start: number, end: number): readonly XtermCompatibilityRow[];
  /** How the active screen's rows moved and changed since the previous call. */
  changes(): RetainedRowChanges;
  /** Normal-screen metadata, also while the alternate screen is active. */
  normalState(): TerminalBufferState;
  /** Normal-screen rows in `[start, end)`, also while the alternate screen is active. */
  normalRows(start: number, end: number): readonly XtermCompatibilityRow[];
  /** Calls `listener` after any change to the terminal, including changes made natively. */
  onChange(listener: () => void): { readonly dispose: () => void };
}

/** Private runtime capability consumed only by the version-matched compatibility package. */
export interface XtermCompatibilityBridge {
  onInput(listener: (data: string | Uint8Array, source: InputSource) => void): {
    readonly dispose: () => void;
  };
  /** Synchronous row access, available when the terminal runs on the main thread. */
  readonly buffer: XtermBufferSource | null;
  /** Mounts the terminal in `container` and keeps its grid, as xterm.js `open()` does. */
  open(container: HTMLElement): Promise<void>;
}

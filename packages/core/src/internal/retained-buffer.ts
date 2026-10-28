import type { CoreRuntime } from '../core/runtime.js';
import type { CoreTerminal } from '../core/terminal.js';
import type { TerminalBufferState } from '../core/types.js';
import type { RetainedRowChanges, XtermCompatibilityRow } from './xterm-compatibility.js';

/** Leaves whichever alternate screen mode is active; each is a no-op on the normal screen. */
const LEAVE_ALTERNATE_SCREEN = '\x1b[?1049l\x1b[?1047l\x1b[?47l';

/**
 * Reads the retained rows of a main-thread terminal on demand, in the packed xterm cell format.
 *
 * @remarks
 * Ghostty only reads the active screen. While the alternate screen is active, the normal screen
 * is read from a clone that is created on first use and dropped by {@link RetainedBuffer.changed}.
 * The owner calls {@link RetainedBuffer.changed} after every state change, which also notifies
 * listeners.
 * @internal
 */
export class RetainedBuffer {
  private readonly runtime: CoreRuntime;
  private readonly terminal: CoreTerminal;
  private readonly listeners = new Set<() => void>();
  private normalClone: CoreTerminal | null = null;
  private disposed = false;

  constructor(runtime: CoreRuntime, terminal: CoreTerminal) {
    this.runtime = runtime;
    this.terminal = terminal;
  }

  /** Active-screen metadata. */
  state(): TerminalBufferState {
    return this.terminal.bufferState();
  }

  /** Active-screen rows in `[start, end)`. */
  rows(start: number, end: number): readonly XtermCompatibilityRow[] {
    return this.terminal.xtermRows(start, end);
  }

  /** How the active screen's rows moved and changed since the previous call. */
  changes(): RetainedRowChanges {
    return this.terminal.retainedRowChanges();
  }

  /** Normal-screen metadata, also while the alternate screen is active. */
  normalState(): TerminalBufferState {
    return this.normalTerminal().bufferState();
  }

  /** Normal-screen rows in `[start, end)`, also while the alternate screen is active. */
  normalRows(start: number, end: number): readonly XtermCompatibilityRow[] {
    return this.normalTerminal().xtermRows(start, end);
  }

  /** Calls `listener` after every change reported to {@link RetainedBuffer.changed}. */
  onChange(listener: () => void): { readonly dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Drops the normal-screen clone and notifies listeners that the terminal changed. */
  changed(): void {
    if (this.disposed) return;
    this.dropClone();
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropClone();
    this.listeners.clear();
  }

  private normalTerminal(): CoreTerminal {
    if (this.terminal.bufferState().screen === 'normal') {
      this.dropClone();
      return this.terminal;
    }
    if (!this.normalClone) {
      const { cols, rows } = this.terminal.geometry;
      const clone = this.runtime.createTerminal({ cols, rows });
      try {
        clone.restore(this.terminal.snapshot());
        clone.write(LEAVE_ALTERNATE_SCREEN);
      } catch (error) {
        clone.dispose();
        throw error;
      }
      this.normalClone = clone;
    }
    return this.normalClone;
  }

  private dropClone(): void {
    this.normalClone?.dispose();
    this.normalClone = null;
  }
}

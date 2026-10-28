import type { Allocation, GhosttyBindings } from './bindings.js';
import type { DirtyState } from './types.js';

/** Viewport rows a reader has not seen yet. */
export interface PendingRows {
  /** Every viewport row changed, for example after scrolling, resizing, or a full redraw. */
  readonly all: boolean;
  /** Changed viewport rows when {@link all} is false. */
  readonly rows: ReadonlySet<number>;
}

/** Converts pending rows into the dirty level reported by render frames. */
export function pendingDirtyState(pending: PendingRows): DirtyState {
  if (pending.all) return 'full';
  return pending.rows.size > 0 ? 'partial' : 'clean';
}

/**
 * One Ghostty render state per terminal, shared by every reader of the viewport.
 *
 * @remarks
 * Updating a Ghostty render state consumes the terminal's dirty flags. With one render state per
 * reader, whichever reader updated first would hide changed rows from the others. A single render
 * state keeps its row data current
 * for every reader, and each update records its changed rows for every registered reader until
 * that reader takes them.
 */
export class SharedRenderState {
  /** Ghostty render state handle, valid after any {@link update}. */
  readonly handle: number;
  private readonly bindings: GhosttyBindings;
  private readonly iterator: number;
  private readonly iteratorSlot: Allocation;
  private readonly scalar: Allocation;
  private readonly readers = new Set<RenderStateReader>();
  private disposed = false;

  constructor(bindings: GhosttyBindings) {
    this.bindings = bindings;
    const e = bindings.exports;
    this.handle = bindings.createHandle('ghostty_render_state_new', (slot) =>
      e.ghostty_render_state_new(0, slot)
    );
    this.iterator = bindings.createHandle('ghostty_render_state_row_iterator_new', (slot) =>
      e.ghostty_render_state_row_iterator_new(0, slot)
    );
    this.iteratorSlot = bindings.alloc(4);
    this.iteratorSlot.view.setUint32(0, this.iterator, true);
    this.scalar = bindings.alloc(4);
  }

  /** Registers a reader that receives every row changed from now on. */
  register(): RenderStateReader {
    const reader = new RenderStateReader();
    this.readers.add(reader);
    return reader;
  }

  /** Brings the render state up to date and records its changed rows for every reader. */
  update(terminal: number): void {
    if (this.disposed) throw new Error('SharedRenderState is disposed');
    const { bindings, handle } = this;
    const e = bindings.exports;
    const abi = bindings.abi;
    bindings.check(e.ghostty_render_state_update(handle, terminal), 'update render state');
    bindings.check(
      e.ghostty_render_state_get(
        handle,
        abi.value('GhosttyRenderStateData', 'DIRTY'),
        this.scalar.pointer
      ),
      'read render state dirty level'
    );
    const dirty = this.scalar.view.getInt32(0, true);
    if (dirty === abi.value('GhosttyRenderStateDirty', 'FALSE')) return;
    let rows: number[] | 'all' = 'all';
    if (dirty === abi.value('GhosttyRenderStateDirty', 'PARTIAL')) {
      bindings.check(
        e.ghostty_render_state_get(
          handle,
          abi.value('GhosttyRenderStateData', 'ROW_ITERATOR'),
          this.iteratorSlot.pointer
        ),
        'bind render state row iterator'
      );
      rows = [];
      while (e.ghostty_render_state_row_iterator_next_dirty(this.iterator, this.scalar.pointer))
        rows.push(this.scalar.view.getUint16(0, true));
    }
    bindings.check(e.ghostty_render_state_clean(handle), 'clean render state');
    for (const reader of this.readers) reader.record(rows);
  }

  /** Releases the Ghostty render state. Readers must not be used afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const e = this.bindings.exports;
    e.ghostty_render_state_row_iterator_free(this.iterator);
    e.ghostty_render_state_free(this.handle);
    this.iteratorSlot.free();
    this.scalar.free();
    this.readers.clear();
  }
}

/** Changed viewport rows collected for one reader of a {@link SharedRenderState}. */
export class RenderStateReader {
  // A new reader has seen nothing, so its first read covers the whole viewport.
  private all = true;
  private rows = new Set<number>();

  /** @internal */
  record(rows: readonly number[] | 'all'): void {
    if (this.all) return;
    if (rows === 'all') {
      this.all = true;
      this.rows.clear();
    } else for (const row of rows) this.rows.add(row);
  }

  /** Marks every viewport row as changed for this reader. */
  invalidate(): void {
    this.all = true;
    this.rows.clear();
  }

  /** Returns the rows changed since the previous call and starts collecting again. */
  take(): PendingRows {
    const pending: PendingRows = { all: this.all, rows: this.rows };
    this.all = false;
    this.rows = new Set();
    return pending;
  }
}

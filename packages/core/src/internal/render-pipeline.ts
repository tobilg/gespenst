import type { CoreTerminal } from '../core/terminal.js';
import type { RenderFrame, TerminalBufferState } from '../core/types.js';
import type { CoreBenchmarkAccumulator } from './benchmark.js';

/** The part of the hybrid renderer a {@link RenderPipeline} drives. @internal */
export interface FramePainter {
  render(frame: RenderFrame): void | Promise<void>;
}

/** Where a {@link RenderPipeline} schedules frames and reports their results. @internal */
export interface RenderPipelineHost {
  /** Runs `callback` before the next frame is presented. */
  schedule(callback: () => void): void;
  /** Whether the terminal session still exists. */
  isActive(): boolean;
  /** Reports the buffer state of a painted frame. */
  rendered(state: TerminalBufferState): void;
  /** Mirrors the painted viewport text for assistive technology. */
  accessibilityRows(rows: readonly string[]): void;
  /** Reports a failure that rejected the pending frame. */
  error(error: Error): void;
}

interface RenderWaiter {
  readonly benchmark?: CoreBenchmarkAccumulator;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** Starts timing one benchmark write. @internal */
export function startBenchmark(): CoreBenchmarkAccumulator {
  return {
    parseMs: 0,
    scheduledAt: 0,
    renderWaitMs: 0,
    renderMs: 0,
    backendStartedAt: performance.now(),
    renderStartedAt: 0,
  };
}

/**
 * Parses output into one terminal and paints it, frame by frame.
 *
 * @remarks
 * The worker host and the main-thread backend both run terminals through this pipeline, so
 * writes and frame boundaries behave the same in both.
 * @internal
 */
export class RenderPipeline {
  /** Whether painted frames also mirror the viewport text for assistive technology. */
  accessibility: boolean;
  private renderPending = false;
  private readonly waiters: RenderWaiter[] = [];
  private readonly terminal: CoreTerminal;
  private readonly painter: FramePainter;
  private readonly host: RenderPipelineHost;

  constructor(
    terminal: CoreTerminal,
    painter: FramePainter,
    host: RenderPipelineHost,
    accessibility: boolean
  ) {
    this.terminal = terminal;
    this.painter = painter;
    this.host = host;
    this.accessibility = accessibility;
  }

  /** Whether a frame is scheduled but not painted yet. */
  get pending(): boolean {
    return this.renderPending;
  }

  /** Parses output and returns the boundary of the frame that paints it. */
  write(data: Uint8Array, benchmark?: CoreBenchmarkAccumulator): Promise<void> {
    const parseStartedAt = benchmark ? performance.now() : 0;
    this.terminal.write(data);
    if (benchmark) {
      benchmark.parseMs = performance.now() - parseStartedAt;
      benchmark.scheduledAt = performance.now();
    }
    return this.scheduleRender(benchmark);
  }

  /** Schedules a frame and returns its boundary. */
  scheduleRender(benchmark?: CoreBenchmarkAccumulator): Promise<void> {
    const rendered = new Promise<void>((resolve, reject) =>
      this.waiters.push({ ...(benchmark ? { benchmark } : {}), resolve, reject })
    );
    // Most mutations schedule opportunistically; keep their disposal rejection observed while
    // preserving rejection for callers that explicitly await the returned boundary.
    void rendered.catch(() => undefined);
    if (this.renderPending) return rendered;
    this.renderPending = true;
    this.host.schedule(() => void this.renderFrame());
    return rendered;
  }

  /** Rejects every waiting frame boundary. The owner disposes the terminal and painter. */
  dispose(): void {
    this.renderPending = false;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Terminal disposed'));
  }

  private async renderFrame(): Promise<void> {
    if (!this.host.isActive()) {
      this.dispose();
      return;
    }
    try {
      const renderStartedAt = performance.now();
      while (true) {
        const iterationStartedAt = performance.now();
        const iterationWaiters = [...this.waiters];
        for (const waiter of iterationWaiters) {
          if (!waiter.benchmark || waiter.benchmark.renderStartedAt !== 0) continue;
          waiter.benchmark.renderWaitMs = iterationStartedAt - waiter.benchmark.scheduledAt;
          waiter.benchmark.renderStartedAt = iterationStartedAt;
        }
        const waiterCount = this.waiters.length;
        const frame = this.terminal.render();
        await this.painter.render(frame);
        if (!this.host.isActive()) return;
        // A write may arrive while an asynchronous renderer recovery is in progress. Render the
        // resulting damage before resolving any boundary that joined this frame.
        if (this.waiters.length === waiterCount) break;
      }
      const waiters = this.waiters.splice(0);
      const renderCompletedAt = performance.now();
      for (const waiter of waiters) {
        if (!waiter.benchmark) continue;
        waiter.benchmark.renderMs =
          renderCompletedAt - (waiter.benchmark.renderStartedAt || renderStartedAt);
      }
      this.renderPending = false;
      this.host.rendered(this.terminal.bufferState());
      if (this.accessibility) {
        this.host.accessibilityRows(this.terminal.viewport().viewportRows.map((row) => row.text));
      }
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      if (!this.host.isActive()) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      const waiters = this.waiters.splice(0);
      this.renderPending = false;
      for (const waiter of waiters) waiter.reject(failure);
      this.host.error(failure);
    }
  }
}

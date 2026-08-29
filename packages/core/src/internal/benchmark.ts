/** Runtime-only benchmark key. It is intentionally absent from the public package exports. */
export const TERMINAL_BENCHMARK_HOOKS = Symbol.for('@gespenst/core/benchmark');

/** Timings collected inside the core execution context for one rendered write. @internal */
export interface CoreBenchmarkTiming {
  /** Time spent parsing bytes through Ghostty's VT state machine. */
  readonly parseMs: number;
  /** Time spent waiting for the renderer's scheduled animation-frame turn. */
  readonly renderWaitMs: number;
  /** Time spent producing and submitting the rendered frame. */
  readonly renderMs: number;
  /** Time spent extracting the optional xterm compatibility delta. */
  readonly compatibilityMs: number;
  /** Total execution-context time from parse start through renderer completion. */
  readonly backendMs: number;
}

/** Mutable worker/local-backend accumulator used only while a measured write is active. @internal */
export interface CoreBenchmarkAccumulator {
  parseMs: number;
  scheduledAt: number;
  renderWaitMs: number;
  renderMs: number;
  compatibilityMs: number;
  backendStartedAt: number;
  renderStartedAt: number;
}

/** A core write result captured without changing the public write boundary. @internal */
export interface CoreBenchmarkWriteResult {
  readonly timing: CoreBenchmarkTiming;
}

/** Runtime hook installed on browser terminals only for repository benchmarks. @internal */
export interface CoreTerminalBenchmarkHooks {
  write(data: string | Uint8Array): Promise<CoreBenchmarkWriteResult>;
}

/** Finalizes a mutable timing record into a structured-clone-safe result. @internal */
export function coreBenchmarkTiming(value: CoreBenchmarkAccumulator): CoreBenchmarkTiming {
  return {
    parseMs: value.parseMs,
    renderWaitMs: value.renderWaitMs,
    renderMs: value.renderMs,
    compatibilityMs: value.compatibilityMs,
    backendMs: performance.now() - value.backendStartedAt,
  };
}

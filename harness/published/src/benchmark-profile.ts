export type BenchmarkProfile = 'ci' | 'full';

export interface ScrollbackWorkload {
  readonly retainedRows: number;
  readonly chunkCount: number;
  readonly sampleCount: number;
}

const STANDARD_SCROLLBACK_CHUNKS = 1_000;
const LARGE_SCROLLBACK_ROWS = 100_000;
const LARGE_SCROLLBACK_CHUNKS = 250;
const LARGE_SCROLLBACK_SAMPLES = 5;

/**
 * Returns bounded scrollback workloads for a benchmark profile.
 *
 * The 100k-row case still preloads the complete buffer, but limits repeated trim writes so the
 * compatibility layer cannot turn one full-profile frame into an effectively unbounded run.
 */
export function scrollbackWorkloads(
  profile: BenchmarkProfile,
  throughputSamples: number
): readonly ScrollbackWorkload[] {
  const retainedRows = profile === 'ci' ? [1_000, 10_000] : [1_000, 10_000, LARGE_SCROLLBACK_ROWS];
  return retainedRows.map((rows) => ({
    retainedRows: rows,
    chunkCount:
      rows === LARGE_SCROLLBACK_ROWS ? LARGE_SCROLLBACK_CHUNKS : STANDARD_SCROLLBACK_CHUNKS,
    sampleCount:
      rows === LARGE_SCROLLBACK_ROWS
        ? Math.min(throughputSamples, LARGE_SCROLLBACK_SAMPLES)
        : throughputSamples,
  }));
}

import { describe, expect, it } from 'vitest';
import { scrollbackWorkloads } from '../harness/published/src/benchmark-profile.js';

describe('browser benchmark profile', () => {
  it('keeps the CI scrollback cases at their normal sample size', () => {
    expect(scrollbackWorkloads('ci', 5)).toEqual([
      { retainedRows: 1_000, chunkCount: 1_000, sampleCount: 5 },
      { retainedRows: 10_000, chunkCount: 1_000, sampleCount: 5 },
    ]);
  });

  it('bounds repeated work at 100k rows without removing the preload case', () => {
    expect(scrollbackWorkloads('full', 20)).toEqual([
      { retainedRows: 1_000, chunkCount: 1_000, sampleCount: 20 },
      { retainedRows: 10_000, chunkCount: 1_000, sampleCount: 20 },
      { retainedRows: 100_000, chunkCount: 250, sampleCount: 5 },
    ]);
  });
});

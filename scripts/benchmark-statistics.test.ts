import { describe, expect, it } from 'vitest';
import { percentile, summarizeSamples } from '../harness/published/src/statistics.js';

describe('browser benchmark statistics', () => {
  it('interpolates percentiles without treating p05 and p95 as array indexes', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.05)).toBeCloseTo(1.2);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8);
  });

  it('uses the correct tail for latency and throughput', () => {
    const samples = [10.01, 10.24, 10.51, 10.79, 11.02];
    expect(summarizeSamples(samples, 'latency').tail).toBe(10.974);
    expect(summarizeSamples(samples, 'throughput').tail).toBe(10.056);
  });

  it('produces reproducible bootstrap confidence intervals', () => {
    const samples = [1.01, 1.8, 2.7, 3.9, 5.2, 8.1, 13.4];
    const first = summarizeSamples(samples, 'latency', 42).confidence95;
    const second = summarizeSamples(samples, 'latency', 42).confidence95;
    expect(first).toEqual(second);
    expect(first.low).toBeLessThanOrEqual(3.9);
    expect(first.high).toBeGreaterThanOrEqual(3.9);
  });

  it('marks high-variance and timer-quantized samples for review', () => {
    expect(summarizeSamples([1, 1, 1, 10, 10], 'latency').warnings).toContain(
      'samples are timing-quantized'
    );
    expect(summarizeSamples([1, 1, 1, 10, 10], 'latency').warnings[0]).toMatch(/high variance/u);
  });
});

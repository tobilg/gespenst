import type { SampleSummary } from './types.js';

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function summarizeSamples(
  values: readonly number[],
  direction: 'latency' | 'throughput',
  seed = 0x5e5e_5e5e
): SampleSummary {
  const mean = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(1, values.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const confidence = bootstrapMedian(values, seed);
  const p50 = percentile(values, 0.5);
  const p05 = percentile(values, 0.05);
  const p95 = percentile(values, 0.95);
  const coefficientOfVariation = mean === 0 ? 0 : standardDeviation / Math.abs(mean);
  const quantized =
    values.length >= 5 &&
    uniqueRounded(values).size <= 2 &&
    values.every((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-7);
  const warnings = [
    ...(coefficientOfVariation > 0.15
      ? [`high variance (${(coefficientOfVariation * 100).toFixed(1)}% CV)`]
      : []),
    ...(quantized ? ['samples are timing-quantized'] : []),
  ];
  return {
    median: round(p50),
    p05: round(p05),
    p95: round(p95),
    minimum: round(values.length ? Math.min(...values) : 0),
    maximum: round(values.length ? Math.max(...values) : 0),
    mean: round(mean),
    standardDeviation: round(standardDeviation),
    coefficientOfVariation: round(coefficientOfVariation),
    confidence95: { low: round(confidence.low), high: round(confidence.high) },
    tail: round(direction === 'latency' ? p95 : p05),
    valid: warnings.length === 0,
    warnings,
    samples: values.map(round),
  };
}

function bootstrapMedian(values: readonly number[], seed: number): { low: number; high: number } {
  if (values.length === 0) return { low: 0, high: 0 };
  const random = mulberry32(seed);
  const medians: number[] = [];
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)] ?? 0
    );
    medians.push(percentile(sample, 0.5));
  }
  return { low: percentile(medians, 0.025), high: percentile(medians, 0.975) };
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b_79f5;
    let output = value;
    output = Math.imul(output ^ (output >>> 15), output | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function uniqueRounded(values: readonly number[]): Set<number> {
  return new Set(values.map((value) => Math.round(value * 1_000_000) / 1_000_000));
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

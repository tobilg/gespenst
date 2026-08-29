import { afterEach, describe, expect, it, vi } from 'vitest';
import { benchmarkFrameTimeoutMs, retryCadence, withTimeout } from './benchmark-runner-utils.mjs';

afterEach(() => {
  vi.useRealTimers();
});

describe('browser benchmark runner controls', () => {
  it('retries cadence failures and reports the discarded attempt', async () => {
    const retries: number[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('animation-frame cadence is unstable'))
      .mockResolvedValue('valid frame');

    await expect(
      retryCadence(operation, {
        attempts: 3,
        onRetry: ({ attempt }) => retries.push(attempt),
      })
    ).resolves.toBe('valid frame');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([1]);
  });

  it('does not retry unrelated failures', async () => {
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(new Error('page crashed'));
    await expect(retryCadence(operation, { attempts: 3 })).rejects.toThrow('page crashed');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('stops retrying after the configured cadence attempts', async () => {
    const operation = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error('animation-frame cadence is unstable'));
    await expect(retryCadence(operation, { attempts: 3 })).rejects.toThrow(
      'animation-frame cadence is unstable'
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('rejects an operation that exceeds its overall timeout', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise(() => {}), 5_000, 'candidate-xterm full frame');
    const assertion = expect(result).rejects.toThrow(
      'candidate-xterm full frame timed out after 5s'
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('uses longer main-frame limits for the full profile', () => {
    expect(benchmarkFrameTimeoutMs('ci', 'main')).toBe(3 * 60_000);
    expect(benchmarkFrameTimeoutMs('full', 'main')).toBe(15 * 60_000);
    expect(benchmarkFrameTimeoutMs('full', 'cold')).toBe(60_000);
  });
});

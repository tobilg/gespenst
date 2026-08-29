export const CADENCE_ERROR = 'animation-frame cadence is unstable';

export function benchmarkFrameTimeoutMs(profile, suite) {
  if (suite === 'cold') return 60_000;
  return profile === 'full' ? 15 * 60_000 : 3 * 60_000;
}

export async function retryCadence(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 0;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new TypeError('Cadence retry attempts must be a positive integer');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isCadenceError(error) || attempt === attempts) throw error;
      options.onRetry?.({ attempt, nextAttempt: attempt + 1, attempts, error });
      if (delayMs > 0) await delay(delayMs);
    }
  }
  throw new Error('Cadence retry loop exhausted unexpectedly');
}

export async function withTimeout(operation, timeoutMs, description) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('Timeout must be a positive finite number');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} timed out after ${formatDuration(timeoutMs)}`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isCadenceError(error) {
  return error instanceof Error && error.message.includes(CADENCE_ERROR);
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function formatDuration(durationMs) {
  if (durationMs % 60_000 === 0) return `${durationMs / 60_000}m`;
  if (durationMs % 1_000 === 0) return `${durationMs / 1_000}s`;
  return `${durationMs}ms`;
}

import type { BenchmarkCaseResult, BenchmarkReport, SampleSummary } from './types.js';

interface FrameResult {
  readonly type: 'gespenst-benchmark-result';
  readonly token: string;
  readonly implementation: string;
  readonly renderer: string;
  readonly cases: readonly BenchmarkCaseResult[];
  readonly memory?: number;
  readonly error?: string;
}

const implementations = [
  { id: 'native-default', label: 'Gespenst native', mode: 'recommended defaults' },
  { id: 'native-canvas', label: 'Gespenst native', mode: 'main-thread Canvas2D' },
  { id: 'gespenst-xterm', label: 'Gespenst xterm API', mode: 'recommended defaults' },
  { id: 'upstream-xterm', label: 'Upstream xterm.js', mode: 'upstream defaults' },
] as const;

export async function runBenchmarkComparison(
  log: (message: string) => void
): Promise<BenchmarkReport> {
  const startedAt = new Date().toISOString();
  const cases: BenchmarkCaseResult[] = [];
  const memory: Record<string, number> = {};
  for (const implementation of implementations) {
    log(`Benchmarking ${implementation.label} (${implementation.mode})`);
    const result = await runFrame(implementation.id);
    if (result.error) throw new Error(`${implementation.label}: ${result.error}`);
    cases.push(...result.cases);
    if (result.memory !== undefined) memory[implementation.id] = result.memory;
    log(`Completed ${implementation.label} with renderer ${result.renderer}`);
  }
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    cases,
    ...(Object.keys(memory).length ? { memory } : {}),
  };
}

function runFrame(implementation: string): Promise<FrameResult> {
  const token = crypto.randomUUID();
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `/benchmark.html?implementation=${encodeURIComponent(implementation)}&token=${encodeURIComponent(token)}`;
  document.body.append(frame);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => finish(new Error(`${implementation} benchmark timed out`)),
      180_000
    );
    const message = (event: MessageEvent<FrameResult>) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.type !== 'gespenst-benchmark-result' ||
        event.data.token !== token
      )
        return;
      finish(event.data);
    };
    const finish = (result: FrameResult | Error) => {
      clearTimeout(timer);
      window.removeEventListener('message', message);
      frame.remove();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    window.addEventListener('message', message);
  });
}

export function summarize(values: readonly number[]): SampleSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    median: round(at(0.5)),
    p95: round(at(0.95)),
    minimum: round(sorted[0] ?? 0),
    maximum: round(sorted.at(-1) ?? 0),
    samples: values.map(round),
  };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

import { summarizeSamples } from './statistics.js';
import type { BenchmarkCaseResult, BenchmarkReport, SampleSummary } from './types.js';

interface FrameResult {
  readonly type: 'gespenst-benchmark-result';
  readonly token: string;
  readonly implementation: string;
  readonly renderer: string;
  readonly cases: readonly BenchmarkCaseResult[];
  readonly frameCadence: SampleSummary;
  readonly health: {
    readonly longTaskCount: number;
    readonly longTaskTotalMs: number;
    readonly longestTaskMs: number;
  };
  readonly validity: { readonly valid: boolean; readonly warnings: readonly string[] };
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
  let frameCadence = summarizeSamples([], 'latency');
  const warnings: string[] = [];
  for (const implementation of implementations) {
    log(`Benchmarking ${implementation.label} (${implementation.mode})`);
    const result = await runFrame(implementation.id);
    if (result.error) throw new Error(`${implementation.label}: ${result.error}`);
    cases.push(...result.cases);
    frameCadence = result.frameCadence;
    warnings.push(...result.validity.warnings.map((warning) => `${implementation.id}: ${warning}`));
    if (result.memory !== undefined) memory[implementation.id] = result.memory;
    log(`Completed ${implementation.label} with renderer ${result.renderer}`);
  }
  return {
    schemaVersion: 2,
    startedAt,
    completedAt: new Date().toISOString(),
    seed: 0x5e5e5e5e,
    frameCadence,
    validity: { valid: warnings.length === 0, warnings },
    cases,
    ...(Object.keys(memory).length ? { memory } : {}),
  };
}

function runFrame(implementation: string): Promise<FrameResult> {
  const token = crypto.randomUUID();
  const frame = document.createElement('iframe');
  frame.title = `${implementation} performance benchmark`;
  frame.style.cssText = 'display:block;width:960px;height:520px;border:0;margin:1rem 0';
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
  return summarizeSamples(values, 'latency');
}

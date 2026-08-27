import '@gespenst/core/style.css';
import '@gespenst/xterm/css/xterm.css';
import '@xterm/xterm/css/xterm.css';
import { summarize } from './benchmarks.js';
import type { BenchmarkCaseResult } from './types.js';

interface BenchmarkTerminal {
  readonly renderer: string;
  write(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  inputBurst(count: number): Promise<void>;
  verify(expected: string): Promise<boolean>;
  dispose(): void;
}

interface Implementation {
  readonly label: string;
  readonly mode: string;
  create(host: HTMLElement): Promise<BenchmarkTerminal>;
}

const params = new URLSearchParams(location.search);
const implementationId = params.get('implementation') ?? '';
const token = params.get('token') ?? '';

void run().then(
  (result) =>
    parent.postMessage({ type: 'gespenst-benchmark-result', token, ...result }, location.origin),
  (reason) =>
    parent.postMessage(
      {
        type: 'gespenst-benchmark-result',
        token,
        implementation: implementationId,
        renderer: 'unknown',
        cases: [],
        error: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      },
      location.origin
    )
);

async function run(): Promise<{
  readonly implementation: string;
  readonly renderer: string;
  readonly cases: readonly BenchmarkCaseResult[];
  readonly memory?: number;
}> {
  const implementation = await loadImplementation(implementationId);
  const cases: BenchmarkCaseResult[] = [];
  const host = requiredHost();

  const coldStart = performance.now();
  const cold = await implementation.create(host);
  await cold.write('cold-ready');
  const coldDuration = performance.now() - coldStart;
  const renderer = cold.renderer;
  cold.dispose();
  host.replaceChildren();
  cases.push(result(implementation, 'cold initialization', 'ms', [coldDuration]));

  const warmSamples: number[] = [];
  for (let index = 0; index < 13; index += 1) {
    const start = performance.now();
    const terminal = await implementation.create(host);
    await terminal.write('warm-ready');
    const duration = performance.now() - start;
    terminal.dispose();
    host.replaceChildren();
    if (index >= 3) warmSamples.push(duration);
  }
  cases.push(result(implementation, 'warm initialization', 'ms', warmSamples));

  const terminal = await implementation.create(host);
  for (const workload of workloads()) {
    const samples: number[] = [];
    for (let index = 0; index < 13; index += 1) {
      const start = performance.now();
      await terminal.write(workload.payload);
      const duration = performance.now() - start;
      if (index >= 3) samples.push(workload.bytes / 1024 / 1024 / (duration / 1_000));
    }
    if (!(await terminal.verify(workload.marker))) {
      throw new Error(`${implementation.label} did not render ${workload.name}`);
    }
    cases.push(result(implementation, workload.name, 'MiB/s', samples));
  }

  await terminal.write(scrollbackPayload());
  const resizeSamples: number[] = [];
  for (let index = 0; index < 13; index += 1) {
    const start = performance.now();
    await terminal.resize(index % 2 === 0 ? 100 : 120, index % 2 === 0 ? 32 : 40);
    const duration = performance.now() - start;
    if (index >= 3) resizeSamples.push(duration);
  }
  cases.push(result(implementation, 'resize and reflow', 'ms', resizeSamples));

  const inputSamples: number[] = [];
  for (let index = 0; index < 13; index += 1) {
    const start = performance.now();
    await terminal.inputBurst(1_000);
    const duration = performance.now() - start;
    if (index >= 3) inputSamples.push(1_000 / (duration / 1_000));
  }
  cases.push(result(implementation, 'input callback throughput', 'events/s', inputSamples));

  terminal.dispose();
  const memory = await measuredMemory();
  return {
    implementation: implementation.label,
    renderer,
    cases,
    ...(memory === undefined ? {} : { memory }),
  };
}

async function loadImplementation(id: string): Promise<Implementation> {
  if (id === 'native-default' || id === 'native-canvas') {
    const { createTerminal } = await import('@gespenst/core');
    const controlled = id === 'native-canvas';
    return {
      label: controlled ? 'Gespenst native / Canvas2D' : 'Gespenst native',
      mode: controlled ? 'main-thread Canvas2D' : 'recommended defaults',
      async create(host) {
        const terminal = await createTerminal({
          container: host,
          cols: 120,
          rows: 40,
          scrollbackLines: 0,
          accessibility: 'off',
          ...(controlled ? { worker: false, renderer: 'canvas2d' as const } : {}),
        });
        return {
          renderer: terminal.renderer.backend,
          write: (data) => terminal.writeAsync(data),
          async resize(cols, rows) {
            terminal.resize(cols, rows);
            await nextFrames(2);
            await terminal.readViewport();
          },
          inputBurst(count) {
            return new Promise((resolve, reject) => {
              let received = 0;
              const timeout = window.setTimeout(
                () => reject(new Error('Native input timed out')),
                5_000
              );
              const subscription = terminal.on('input', () => {
                received += 1;
                if (received !== count) return;
                clearTimeout(timeout);
                subscription.dispose();
                resolve();
              });
              for (let index = 0; index < count; index += 1) terminal.sendText('x');
            });
          },
          async verify(expected) {
            return (await terminal.readBuffer()).rows.some((row) => row.text.includes(expected));
          },
          dispose: () => terminal.dispose(),
        };
      },
    };
  }
  if (id === 'gespenst-xterm') {
    const { Terminal } = await import('@gespenst/xterm');
    return {
      label: 'Gespenst xterm API',
      mode: 'recommended defaults',
      async create(host) {
        const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 0 });
        terminal.open(host);
        await terminal.ready;
        return xtermAdapter(terminal, (await terminal.native).renderer.backend);
      },
    };
  }
  if (id === 'upstream-xterm') {
    const { Terminal } = await import('@xterm/xterm');
    return {
      label: 'Upstream xterm.js',
      mode: 'upstream defaults',
      async create(host) {
        const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 0 });
        terminal.open(host);
        await nextFrames(2);
        return xtermAdapter(terminal, 'upstream');
      },
    };
  }
  throw new Error(`Unknown benchmark implementation ${id}`);
}

function xtermAdapter(
  terminal: import('@gespenst/xterm').Terminal | import('@xterm/xterm').Terminal,
  renderer: string
): BenchmarkTerminal {
  return {
    renderer,
    async write(data) {
      await new Promise<void>((resolve) => terminal.write(data, resolve));
      await nextFrames(2);
    },
    async resize(cols, rows) {
      terminal.resize(cols, rows);
      await nextFrames(2);
    },
    inputBurst(count) {
      return new Promise((resolve, reject) => {
        let received = 0;
        const timeout = window.setTimeout(() => reject(new Error('xterm input timed out')), 5_000);
        const subscription = terminal.onData(() => {
          received += 1;
          if (received !== count) return;
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        });
        for (let index = 0; index < count; index += 1) terminal.input('x');
      });
    },
    async verify(expected) {
      for (let index = 0; index < terminal.buffer.active.length; index += 1) {
        if (terminal.buffer.active.getLine(index)?.translateToString(true).includes(expected))
          return true;
      }
      return false;
    },
    dispose: () => terminal.dispose(),
  };
}

function workloads(): ReadonlyArray<{
  readonly name: string;
  readonly marker: string;
  readonly payload: Uint8Array;
  readonly bytes: number;
}> {
  return [
    payload(
      'ASCII interactive 64 KiB',
      'ascii64',
      'plain benchmark output xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n',
      64 * 1024
    ),
    payload(
      'ANSI interactive 64 KiB',
      'ansi64',
      '\u001b[38;2;80;180;130mcolored benchmark\u001b[0m xxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n',
      64 * 1024
    ),
    payload(
      'Unicode interactive 64 KiB',
      'unicode64',
      'unicode benchmark 界🙂 e\u0301 powerline \ue0b0\ue0b2 xxxxxxxxxxxxxxxxx\r\n',
      64 * 1024
    ),
    payload(
      'ASCII bulk 1 MiB',
      'ascii1m',
      'plain benchmark output xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n',
      1024 * 1024
    ),
    payload(
      'ANSI bulk 1 MiB',
      'ansi1m',
      '\u001b[38;2;80;180;130mcolored benchmark\u001b[0m xxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n',
      1024 * 1024
    ),
    payload(
      'Unicode bulk 1 MiB',
      'unicode1m',
      'unicode benchmark 界🙂 e\u0301 powerline \ue0b0\ue0b2 xxxxxxxxxxxxxxxxx\r\n',
      1024 * 1024
    ),
  ];
}

function payload(name: string, marker: string, row: string, targetBytes: number) {
  const encoder = new TextEncoder();
  const suffix = `\r\n${marker}\r\n`;
  const repeated = row.repeat(Math.ceil(targetBytes / encoder.encode(row).byteLength));
  const bytes = encoder.encode(`${repeated}${suffix}`);
  return { name, marker, payload: bytes, bytes: bytes.byteLength };
}

function scrollbackPayload(): Uint8Array {
  return new TextEncoder().encode(
    Array.from(
      { length: 1_000 },
      (_, index) => `scrollback ${String(index).padStart(4, '0')} ${'x'.repeat(72)}\r\n`
    ).join('')
  );
}

function result(
  implementation: Implementation,
  workload: string,
  unit: string,
  values: readonly number[]
): BenchmarkCaseResult {
  return {
    implementation: implementation.label,
    mode: implementation.mode,
    workload,
    unit,
    summary: summarize(values),
  };
}

function requiredHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>('#benchmark-host');
  if (!host) throw new Error('Benchmark host is missing');
  host.style.cssText = 'width:960px;height:500px;position:relative;overflow:hidden';
  return host;
}

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const frame = () => {
      count -= 1;
      if (count <= 0) resolve();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function measuredMemory(): Promise<number | undefined> {
  const memory = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ readonly bytes: number }>;
  };
  if (!memory.measureUserAgentSpecificMemory || !crossOriginIsolated) return undefined;
  try {
    return (await memory.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return undefined;
  }
}

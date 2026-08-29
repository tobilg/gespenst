import '@gespenst/core/style.css';
import '@gespenst/xterm/css/xterm.css';
import '@xterm/xterm/css/xterm.css';
import { scrollbackWorkloads } from './benchmark-profile.js';
import { summarizeSamples } from './statistics.js';
import type { BenchmarkCaseResult, SampleSummary } from './types.js';

interface PhaseMeasurement {
  readonly totalMs: number;
  readonly phases: Readonly<Record<string, number>>;
}

interface BenchmarkTerminal {
  readonly renderer: string;
  writeMeasured(data: string | Uint8Array): Promise<PhaseMeasurement>;
  writePresentation(data: string | Uint8Array): Promise<number>;
  writeBurst(chunks: readonly Uint8Array[], paced: boolean): Promise<number>;
  resizePresentation(cols: number, rows: number): Promise<number>;
  resizeBurst(count: number): Promise<number>;
  inputDom(count: number): Promise<number>;
  verify(expected: string): Promise<boolean>;
  settle(): Promise<void>;
  dispose(): void;
}

interface XtermLikeTerminal {
  readonly buffer: {
    readonly active: {
      readonly length: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  readonly parser: {
    registerCsiHandler(
      identifier: { readonly final: string },
      callback: () => boolean
    ): { dispose(): void };
  };
  readonly textarea: HTMLTextAreaElement | undefined;
  dispose(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onLineFeed(listener: () => void): { dispose(): void };
  onRender(listener: () => void): { dispose(): void };
  open(parent: HTMLElement): void;
  resize(cols: number, rows: number): void;
  write(data: string | Uint8Array, callback?: () => void): void;
}

interface Implementation {
  readonly label: string;
  readonly mode: string;
  create(
    host: HTMLElement,
    options?: { readonly scrollback?: number; readonly listeners?: boolean }
  ): Promise<BenchmarkTerminal>;
}

interface FrameResult {
  readonly schemaVersion: 2;
  readonly implementation: string;
  readonly mode: string;
  readonly renderer: string;
  readonly cases: readonly BenchmarkCaseResult[];
  readonly frameCadence: SampleSummary;
  readonly health: {
    readonly longTaskCount: number;
    readonly longTaskTotalMs: number;
    readonly longestTaskMs: number;
  };
  readonly validity: { readonly valid: boolean; readonly warnings: readonly string[] };
}

interface CoreTiming {
  readonly parseMs: number;
  readonly renderWaitMs: number;
  readonly renderMs: number;
  readonly compatibilityMs: number;
  readonly backendMs: number;
}

interface CoreBenchmarkHooks {
  write(data: string | Uint8Array): Promise<{ readonly timing: CoreTiming }>;
}

interface XtermTiming {
  readonly queueMs: number;
  readonly adapterMs: number;
  readonly bufferSyncMs: number;
  readonly callbackMs: number;
  readonly totalMs: number;
  readonly core?: CoreTiming;
}

interface XtermBenchmarkHooks {
  write(data: string | Uint8Array): Promise<XtermTiming>;
}

const CORE_BENCHMARK_HOOKS = Symbol.for('@gespenst/core/benchmark');
const XTERM_BENCHMARK_HOOKS = Symbol.for('@gespenst/xterm/benchmark');
const params = new URLSearchParams(location.search);
const implementationId = params.get('implementation') ?? '';
const token = params.get('token') ?? '';
const profile = params.get('profile') === 'ci' ? 'ci' : 'full';
const suite = params.get('suite') === 'cold' ? 'cold' : 'main';
const latencySamples = profile === 'ci' ? 10 : 30;
const throughputSamples = profile === 'ci' ? 5 : 20;
const throughputWindowMs = profile === 'ci' ? 100 : 250;
const warmups = profile === 'ci' ? 3 : 5;
const longTaskDurations: number[] = [];
const longTaskObserver = observeLongTasks(longTaskDurations);

const benchmark = run();
window.__gespenstBenchmarkFrame = benchmark;
if (parent !== window) {
  void benchmark.then(
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
}

async function run(): Promise<FrameResult> {
  const implementation = await loadImplementation(implementationId);
  const cases: BenchmarkCaseResult[] = [];
  const host = requiredHost();
  if (suite === 'cold') {
    const startedAt = performance.now();
    const terminal = await implementation.create(host);
    const renderer = terminal.renderer;
    try {
      await terminal.writePresentation('cold-start-ready');
    } finally {
      await terminal.settle();
      terminal.dispose();
    }
    cases.push(
      makeCase(
        implementation,
        'cold initialization and first presented write',
        'initialization',
        'latency',
        'ms',
        [performance.now() - startedAt]
      )
    );
    return {
      schemaVersion: 2,
      implementation: implementation.label,
      mode: implementation.mode,
      renderer,
      cases,
      frameCadence: summarizeSamples([], 'latency'),
      health: runtimeHealth(longTaskDurations),
      validity: { valid: true, warnings: [] },
    };
  }
  const cadence = summarizeSamples(await frameCadence(60), 'latency');
  const validityWarnings = [
    ...(document.visibilityState !== 'visible' ? ['benchmark document is not visible'] : []),
    ...(cadence.coefficientOfVariation > 0.1 ? ['animation-frame cadence is unstable'] : []),
  ];
  if (validityWarnings.length) throw new Error(validityWarnings.join('; '));

  cases.push(
    makeCase(
      implementation,
      'warm initialization and first rendered write',
      'initialization',
      'latency',
      'ms',
      await measureInitialization(implementation, host)
    )
  );

  const terminal = await implementation.create(host);
  const renderer = terminal.renderer;
  try {
    for (const size of [32, 256, 1024, 16 * 1024]) {
      const workload = payload(`latency-${size}`, ansiRow, size);
      const measurements = await measureWrites(terminal, workload.payload, latencySamples);
      cases.push(
        makeCase(
          implementation,
          `ANSI write ${formatBytes(size)}`,
          'callback',
          'latency',
          'ms',
          measurements.map(({ totalMs }) => totalMs),
          workload.bytes,
          phaseSummaries(measurements)
        )
      );
      const parse = measurements
        .map(({ phases }) => phases.parse)
        .filter((value): value is number => value !== undefined);
      if (parse.length === measurements.length) {
        cases.push(
          makeCase(
            implementation,
            `ANSI parser ${formatBytes(size)}`,
            'parser',
            'latency',
            'ms',
            parse,
            workload.bytes
          )
        );
      }
    }

    for (const workload of bulkWorkloads(profile)) {
      const throughput = await calibratedThroughput(terminal, workload.payload);
      if (!(await terminal.verify(workload.marker)))
        throw new Error(`${implementation.label} did not retain ${workload.marker}`);
      cases.push(
        makeCase(
          implementation,
          workload.name,
          'callback',
          'throughput',
          'MiB/s',
          throughput,
          workload.bytes
        )
      );
    }

    const visual = payload('visual-marker', ansiRow, 1024);
    const visualSamples: number[] = [];
    for (let index = 0; index < latencySamples; index += 1)
      visualSamples.push(await terminal.writePresentation(visual.payload));
    cases.push(
      makeCase(
        implementation,
        'ANSI render to next frame 1 KiB',
        'presentation',
        'latency',
        'ms',
        visualSamples,
        visual.bytes
      )
    );

    for (const chunkSize of [1024, 16 * 1024]) {
      for (const paced of [false, true]) {
        const stream = payload(
          'stream-marker',
          ansiRow,
          paced
            ? chunkSize === 1024
              ? profile === 'ci'
                ? 16 * 1024
                : 64 * 1024
              : profile === 'ci'
                ? 64 * 1024
                : 256 * 1024
            : profile === 'ci'
              ? 256 * 1024
              : 1024 * 1024
        );
        const chunks = splitBytes(stream.payload, chunkSize);
        const values: number[] = [];
        for (let index = 0; index < throughputSamples; index += 1) {
          const duration = await terminal.writeBurst(chunks, paced);
          values.push(mibPerSecond(stream.bytes, duration));
        }
        cases.push(
          makeCase(
            implementation,
            `${paced ? 'paced' : 'burst'} stream / ${formatBytes(chunkSize)} chunks`,
            'callback',
            'throughput',
            'MiB/s',
            values,
            stream.bytes
          )
        );
      }
    }

    const resizeLatency: number[] = [];
    for (let index = 0; index < latencySamples; index += 1)
      resizeLatency.push(
        await terminal.resizePresentation(index % 2 === 0 ? 100 : 120, index % 2 === 0 ? 32 : 40)
      );
    cases.push(
      makeCase(
        implementation,
        'single resize to next frame',
        'presentation',
        'latency',
        'ms',
        resizeLatency
      )
    );
    const resizeBurst: number[] = [];
    for (let index = 0; index < throughputSamples; index += 1) {
      const duration = await terminal.resizeBurst(100);
      resizeBurst.push(100 / (duration / 1_000));
    }
    cases.push(
      makeCase(
        implementation,
        'batched resize and reflow',
        'render',
        'throughput',
        'operations/s',
        resizeBurst
      )
    );

    const inputSamples: number[] = [];
    for (let index = 0; index < throughputSamples; index += 1) {
      const duration = await terminal.inputDom(1_000);
      inputSamples.push(1_000 / (duration / 1_000));
    }
    cases.push(
      makeCase(
        implementation,
        'DOM text input path',
        'input',
        'throughput',
        'events/s',
        inputSamples
      )
    );
  } finally {
    await terminal.settle();
    terminal.dispose();
  }

  for (const { retainedRows, chunkCount, sampleCount } of scrollbackWorkloads(
    profile,
    throughputSamples
  )) {
    host.replaceChildren();
    const scrollback = await implementation.create(host, { scrollback: retainedRows });
    try {
      await scrollback.writeMeasured(scrollbackPayload(retainedRows + 80));
      const chunks = Array.from({ length: chunkCount }, (_, index) =>
        new TextEncoder().encode(`\r\ntrim-${retainedRows}-${index}`)
      );
      const samples: number[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const duration = await scrollback.writeBurst(chunks, false);
        samples.push(chunkCount / (duration / 1_000));
      }
      cases.push(
        makeCase(
          implementation,
          `append and trim / ${retainedRows} retained rows`,
          'callback',
          'throughput',
          'rows/s',
          samples
        )
      );
    } finally {
      await scrollback.settle();
      scrollback.dispose();
    }
  }

  return {
    schemaVersion: 2,
    implementation: implementation.label,
    mode: implementation.mode,
    renderer,
    cases,
    frameCadence: cadence,
    health: runtimeHealth(longTaskDurations),
    validity: { valid: validityWarnings.length === 0, warnings: validityWarnings },
  };
}

function observeLongTasks(output: number[]): PerformanceObserver | undefined {
  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes.includes('longtask')
  )
    return undefined;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) output.push(entry.duration);
  });
  observer.observe({ entryTypes: ['longtask'] });
  return observer;
}

function runtimeHealth(values: readonly number[]) {
  longTaskObserver?.takeRecords().forEach((entry) => {
    longTaskDurations.push(entry.duration);
  });
  return {
    longTaskCount: values.length,
    longTaskTotalMs: round(values.reduce((total, value) => total + value, 0)),
    longestTaskMs: round(values.length ? Math.max(...values) : 0),
  };
}

async function measureInitialization(
  implementation: Implementation,
  host: HTMLElement
): Promise<readonly number[]> {
  const samples: number[] = [];
  for (let index = 0; index < warmups + latencySamples; index += 1) {
    host.replaceChildren();
    const startedAt = performance.now();
    const terminal = await implementation.create(host);
    await terminal.writePresentation(`init-${index}`);
    const duration = performance.now() - startedAt;
    await terminal.settle();
    terminal.dispose();
    if (index >= warmups) samples.push(duration);
  }
  host.replaceChildren();
  return samples;
}

async function measureWrites(
  terminal: BenchmarkTerminal,
  data: Uint8Array,
  count: number
): Promise<readonly PhaseMeasurement[]> {
  for (let index = 0; index < warmups; index += 1) await terminal.writeMeasured(data);
  const output: PhaseMeasurement[] = [];
  for (let index = 0; index < count; index += 1) output.push(await terminal.writeMeasured(data));
  return output;
}

async function calibratedThroughput(
  terminal: BenchmarkTerminal,
  data: Uint8Array
): Promise<readonly number[]> {
  for (let index = 0; index < warmups; index += 1) await terminal.writeMeasured(data);
  const samples: number[] = [];
  for (let sample = 0; sample < throughputSamples; sample += 1) {
    let bytes = 0;
    const startedAt = performance.now();
    let duration = 0;
    do {
      await terminal.writeMeasured(data);
      bytes += data.byteLength;
      duration = performance.now() - startedAt;
    } while (duration < throughputWindowMs);
    samples.push(mibPerSecond(bytes, duration));
  }
  return samples;
}

async function loadImplementation(id: string): Promise<Implementation> {
  if (id === 'native-default' || id === 'native-canvas') {
    const { createTerminal } = await import('@gespenst/core');
    const controlled = id === 'native-canvas';
    return {
      label: controlled ? 'Gespenst native / Canvas2D' : 'Gespenst native',
      mode: controlled ? 'controlled main-thread Canvas2D' : 'product defaults',
      async create(host, options) {
        const terminal = await createTerminal({
          container: host,
          cols: 120,
          rows: 40,
          scrollbackLines: options?.scrollback ?? 0,
          accessibility: 'off',
          fontFamily: 'monospace',
          ...(controlled ? { worker: false, renderer: 'canvas2d' as const } : {}),
        });
        const hook = (terminal as unknown as Record<symbol, CoreBenchmarkHooks | undefined>)[
          CORE_BENCHMARK_HOOKS
        ];
        const writeMeasured = async (data: string | Uint8Array): Promise<PhaseMeasurement> => {
          const startedAt = performance.now();
          if (hook) {
            const { timing } = await hook.write(data);
            return { totalMs: performance.now() - startedAt, phases: corePhases(timing) };
          }
          await terminal.writeAsync(data);
          return { totalMs: performance.now() - startedAt, phases: {} };
        };
        return {
          renderer: terminal.renderer.backend,
          writeMeasured,
          async writePresentation(data) {
            const rendered = onceCoreRender(terminal);
            const startedAt = performance.now();
            await Promise.all([writeMeasured(data), rendered]);
            await nextFrames(1);
            return performance.now() - startedAt;
          },
          async writeBurst(chunks, paced) {
            const startedAt = performance.now();
            if (paced) {
              for (const chunk of chunks) await terminal.writeAsync(chunk);
            } else if (chunks.length > 0) {
              for (const chunk of chunks.slice(0, -1)) terminal.write(chunk);
              const last = chunks.at(-1);
              if (last) await terminal.writeAsync(last);
            }
            return performance.now() - startedAt;
          },
          async resizePresentation(cols, rows) {
            const startedAt = performance.now();
            terminal.resize(cols, rows);
            await nextFrames(1);
            await terminal.readViewport();
            return performance.now() - startedAt;
          },
          async resizeBurst(count) {
            const startedAt = performance.now();
            for (let index = 0; index < count; index += 1)
              terminal.resize(index % 2 === 0 ? 100 : 120, index % 2 === 0 ? 32 : 40);
            await nextFrames(1);
            await terminal.readViewport();
            return performance.now() - startedAt;
          },
          inputDom: (count) => nativeDomInput(terminal, count),
          async verify(expected) {
            return (await terminal.readBuffer()).rows.some((row: { readonly text: string }) =>
              row.text.includes(expected)
            );
          },
          async settle() {
            await terminal.writeAsync(new Uint8Array());
            await nextFrames(1);
          },
          dispose: () => terminal.dispose(),
        };
      },
    };
  }

  const gespenst = id.startsWith('gespenst-xterm');
  if (gespenst || id.startsWith('upstream-xterm')) {
    const TerminalClass = (gespenst
      ? (await import('@gespenst/xterm')).Terminal
      : (await import('@xterm/xterm')).Terminal) as unknown as new (options: {
      readonly cols: number;
      readonly rows: number;
      readonly scrollback: number;
      readonly fontFamily: string;
      readonly logLevel: string;
    }) => XtermLikeTerminal;
    const listeners = id.endsWith('-listeners');
    return {
      label: `${gespenst ? 'Gespenst xterm API' : 'Upstream xterm.js'}${listeners ? ' / listeners' : ''}`,
      mode: listeners ? 'product defaults with listeners and parser hook' : 'product defaults',
      async create(host, options) {
        const terminal = new TerminalClass({
          cols: 120,
          rows: 40,
          scrollback: options?.scrollback ?? 0,
          fontFamily: 'monospace',
          logLevel: 'off',
        });
        terminal.open(host);
        if ('ready' in terminal)
          await (terminal as XtermLikeTerminal & { readonly ready: Promise<void> }).ready;
        else await nextFrames(1);
        if (listeners || options?.listeners) {
          terminal.onLineFeed(() => undefined);
          terminal.onRender(() => undefined);
          terminal.parser.registerCsiHandler({ final: 'm' }, () => false);
        }
        const hook = (terminal as unknown as Record<symbol, XtermBenchmarkHooks | undefined>)[
          XTERM_BENCHMARK_HOOKS
        ];
        const renderer =
          gespenst && 'native' in terminal
            ? (
                await (
                  terminal as XtermLikeTerminal & {
                    readonly native: Promise<{ readonly renderer: { readonly backend: string } }>;
                  }
                ).native
              ).renderer.backend
            : 'canvas2d';
        return xtermAdapter(terminal, renderer, hook);
      },
    };
  }
  throw new Error(`Unknown benchmark implementation ${id}`);
}

function xtermAdapter(
  terminal: XtermLikeTerminal,
  renderer: string,
  hook?: XtermBenchmarkHooks
): BenchmarkTerminal {
  const writeMeasured = async (data: string | Uint8Array): Promise<PhaseMeasurement> => {
    const startedAt = performance.now();
    if (hook) {
      const timing = await hook.write(data);
      return { totalMs: performance.now() - startedAt, phases: xtermPhases(timing) };
    }
    await xtermWrite(terminal, data);
    const totalMs = performance.now() - startedAt;
    return { totalMs, phases: {} };
  };
  return {
    renderer,
    writeMeasured,
    async writePresentation(data) {
      const rendered = onceXtermRender(terminal);
      const startedAt = performance.now();
      await Promise.all([writeMeasured(data), rendered]);
      await nextFrames(1);
      return performance.now() - startedAt;
    },
    async writeBurst(chunks, paced) {
      const startedAt = performance.now();
      if (paced) {
        for (const chunk of chunks) await xtermWrite(terminal, chunk);
      } else if (chunks.length > 0) {
        for (const chunk of chunks.slice(0, -1)) terminal.write(chunk);
        const last = chunks.at(-1);
        if (last) await xtermWrite(terminal, last);
      }
      return performance.now() - startedAt;
    },
    async resizePresentation(cols, rows) {
      const startedAt = performance.now();
      terminal.resize(cols, rows);
      await nextFrames(1);
      return performance.now() - startedAt;
    },
    async resizeBurst(count) {
      const startedAt = performance.now();
      for (let index = 0; index < count; index += 1)
        terminal.resize(index % 2 === 0 ? 100 : 120, index % 2 === 0 ? 32 : 40);
      await nextFrames(1);
      return performance.now() - startedAt;
    },
    inputDom: (count) => xtermDomInput(terminal, count),
    async verify(expected) {
      for (let index = 0; index < terminal.buffer.active.length; index += 1) {
        if (terminal.buffer.active.getLine(index)?.translateToString(true).includes(expected))
          return true;
      }
      return false;
    },
    async settle() {
      await xtermWrite(terminal, new Uint8Array());
      await nextFrames(1);
    },
    dispose: () => terminal.dispose(),
  };
}

function makeCase(
  implementation: Implementation,
  workload: string,
  boundary: BenchmarkCaseResult['boundary'],
  direction: BenchmarkCaseResult['direction'],
  unit: string,
  values: readonly number[],
  bytes?: number,
  phases?: Readonly<Record<string, SampleSummary>>
): BenchmarkCaseResult {
  return {
    implementation: implementation.label,
    mode: implementation.mode,
    workload,
    boundary,
    direction,
    unit,
    summary: summarizeSamples(values, direction),
    ...(bytes === undefined ? {} : { bytes }),
    ...(phases && Object.keys(phases).length > 0 ? { phases } : {}),
  };
}

function phaseSummaries(
  measurements: readonly PhaseMeasurement[]
): Readonly<Record<string, SampleSummary>> {
  const names = new Set(measurements.flatMap(({ phases }) => Object.keys(phases)));
  return Object.fromEntries(
    [...names].map((name) => [
      name,
      summarizeSamples(
        measurements
          .map(({ phases }) => phases[name])
          .filter((value): value is number => value !== undefined),
        'latency'
      ),
    ])
  );
}

function corePhases(timing: CoreTiming): Readonly<Record<string, number>> {
  return {
    parse: timing.parseMs,
    renderWait: timing.renderWaitMs,
    render: timing.renderMs,
    compatibilityDelta: timing.compatibilityMs,
    backend: timing.backendMs,
  };
}

function xtermPhases(timing: XtermTiming): Readonly<Record<string, number>> {
  return {
    total: timing.totalMs,
    queue: timing.queueMs,
    adapter: timing.adapterMs,
    bufferSync: timing.bufferSyncMs,
    callback: timing.callbackMs,
    ...(timing.core ? corePhases(timing.core) : {}),
  };
}

function bulkWorkloads(mode: 'ci' | 'full') {
  const bulkBytes = mode === 'ci' ? 1024 * 1024 : 10 * 1024 * 1024;
  return [
    payload('ascii-bulk', asciiRow, bulkBytes, 'ASCII bulk'),
    payload('ansi-bulk', ansiRow, bulkBytes, 'ANSI bulk'),
    payload('unicode-bulk', unicodeRow, bulkBytes, 'Unicode bulk'),
    payload('redraw-bulk', redrawRow, bulkBytes, 'Cursor and redraw trace'),
  ];
}

function payload(marker: string, row: string, targetBytes: number, name = marker) {
  const encoder = new TextEncoder();
  const suffix = `\r\n${marker}\r\n`;
  const repeated = row.repeat(Math.ceil(targetBytes / encoder.encode(row).byteLength));
  const bytes = encoder.encode(`${repeated}${suffix}`);
  return { name, marker, payload: bytes, bytes: bytes.byteLength };
}

const asciiRow = `terminal output ${'x'.repeat(72)}\r\n`;
const ansiRow = `\u001b[38;2;80;180;130mcolored output\u001b[0m ${'x'.repeat(58)}\r\n`;
const unicodeRow = `unicode \u754c\ud83d\ude42 e\u0301 powerline \ue0b0\ue0b2 ${'x'.repeat(48)}\r\n`;
const redrawRow = '\u001b[2K\rprogress \u001b[32m42%\u001b[0m\u001b[10C\u001b[5Ddone\r\n';

function splitBytes(value: Uint8Array, size: number): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < value.byteLength; offset += size)
    chunks.push(value.subarray(offset, Math.min(value.byteLength, offset + size)));
  return chunks;
}

function scrollbackPayload(lines: number): Uint8Array {
  return new TextEncoder().encode(
    Array.from(
      { length: lines },
      (_, index) => `scrollback ${String(index).padStart(6, '0')} ${'x'.repeat(72)}\r\n`
    ).join('')
  );
}

function onceCoreRender(terminal: import('@gespenst/core').GespenstTerminal): Promise<void> {
  return new Promise((resolve, reject) => {
    let subscription: { dispose(): void } | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      subscription?.dispose();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('Core render event timed out')), 5_000);
    subscription = terminal.on('viewportChange', () => finish());
  });
}

function onceXtermRender(terminal: XtermLikeTerminal): Promise<void> {
  return new Promise((resolve, reject) => {
    let subscription: { dispose(): void } | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      subscription?.dispose();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('xterm render event timed out')), 5_000);
    subscription = terminal.onRender(() => finish());
  });
}

function xtermWrite(terminal: XtermLikeTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function xtermDomInput(terminal: XtermLikeTerminal, count: number): Promise<number> {
  const target = terminal.textarea;
  if (!target) return Promise.reject(new Error('xterm input textarea is unavailable'));
  return dispatchDomKeys(target, (listener) => terminal.onData(listener), count);
}

function nativeDomInput(
  terminal: import('@gespenst/core').GespenstTerminal,
  count: number
): Promise<number> {
  const target = terminal.element.querySelector('textarea');
  if (!(target instanceof HTMLTextAreaElement))
    return Promise.reject(new Error('Core input textarea is unavailable'));
  return dispatchDomKeys(target, (listener) => terminal.on('input', () => listener('x')), count);
}

function dispatchDomKeys(
  target: HTMLTextAreaElement,
  subscribe: (listener: (data: string) => void) => { dispose(): void },
  count: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = 0;
    let subscription: { dispose(): void } | undefined;
    const startedAt = performance.now();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      subscription?.dispose();
      if (error) reject(error);
      else resolve(performance.now() - startedAt);
    };
    const timeout = setTimeout(() => finish(new Error('DOM input benchmark timed out')), 5_000);
    subscription = subscribe(() => {
      received += 1;
      if (received === count) finish();
    });
    target.focus();
    for (let index = 0; index < count; index += 1) {
      target.value = 'x';
      target.dispatchEvent(
        new InputEvent('input', {
          data: 'x',
          inputType: 'insertText',
          bubbles: true,
          cancelable: false,
        })
      );
    }
  });
}

async function frameCadence(count: number): Promise<readonly number[]> {
  const output: number[] = [];
  let previous = performance.now();
  for (let index = 0; index < count; index += 1) {
    await nextFrames(1);
    const current = performance.now();
    output.push(current - previous);
    previous = current;
  }
  return output.slice(5);
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

function requiredHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>('#benchmark-host');
  if (!host) throw new Error('Benchmark host is missing');
  host.style.cssText = 'width:960px;height:500px;position:relative;overflow:hidden';
  return host;
}

function mibPerSecond(bytes: number, durationMs: number): number {
  return bytes / 1024 / 1024 / (durationMs / 1_000);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

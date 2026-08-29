export type ScenarioStatus = 'idle' | 'running' | 'passed' | 'failed' | 'skipped';

export interface PublishedPackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarball: string;
  readonly scenario: string;
}

export interface HarnessMetadata {
  readonly selector: string;
  readonly generatedAt: string;
  readonly websocketToken: string;
  readonly consumerDependencies: Readonly<Record<string, string>>;
  readonly packages: readonly PublishedPackageMetadata[];
  readonly upstreamXterm: PublishedPackageMetadata;
  readonly bundles?: Readonly<Record<string, BundleReport>>;
}

export interface ScenarioResult {
  readonly id: string;
  readonly label: string;
  readonly status: Exclude<ScenarioStatus, 'idle' | 'running'>;
  readonly durationMs: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface FunctionalReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly renderer: string | null;
  readonly scenarios: readonly ScenarioResult[];
}

export interface SampleSummary {
  readonly median: number;
  readonly p05: number;
  readonly p95: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly mean: number;
  readonly standardDeviation: number;
  readonly coefficientOfVariation: number;
  readonly confidence95: { readonly low: number; readonly high: number };
  readonly tail: number;
  readonly valid: boolean;
  readonly warnings: readonly string[];
  readonly samples: readonly number[];
}

export interface BenchmarkCaseResult {
  readonly implementation: string;
  readonly mode: string;
  readonly workload: string;
  readonly boundary: 'initialization' | 'parser' | 'callback' | 'render' | 'presentation' | 'input';
  readonly direction: 'latency' | 'throughput';
  readonly unit: string;
  readonly summary: SampleSummary;
  readonly bytes?: number;
  readonly phases?: Readonly<Record<string, SampleSummary>>;
}

export interface BenchmarkReport {
  readonly schemaVersion: 2;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly seed: number;
  readonly frameCadence: SampleSummary;
  readonly validity: { readonly valid: boolean; readonly warnings: readonly string[] };
  readonly cases: readonly BenchmarkCaseResult[];
  readonly memory?: Readonly<Record<string, number>>;
}

export interface BundleAsset {
  readonly file: string;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly brotliBytes: number;
}

export interface BundleReport {
  readonly assets: readonly BundleAsset[];
  readonly totals: Readonly<Record<string, number>>;
}

export interface BrowserHarnessReport {
  readonly metadata: HarnessMetadata;
  readonly userAgent: string;
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly functional: FunctionalReport;
  readonly benchmarks?: BenchmarkReport;
}

declare global {
  interface Window {
    __gespenstPublishedHarness: Promise<BrowserHarnessReport>;
    __gespenstRunFunctional: () => Promise<FunctionalReport>;
    __gespenstRunBenchmarks: () => Promise<BenchmarkReport>;
    __gespenstBenchmarkFrame?: Promise<unknown>;
  }
}

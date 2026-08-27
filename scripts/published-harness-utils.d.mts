export interface RegistryPackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarball: string;
}

export interface PublishedHarnessOptions {
  readonly command: 'test' | 'dev';
  readonly selector: string;
  readonly browsers: readonly string[];
  readonly host: string;
  readonly keep: boolean;
}

export const PUBLISHED_SCENARIOS: Readonly<Record<string, string>>;
export const EXTERNAL_CONSUMER_DEPENDENCIES: Readonly<Record<string, string>>;
export function parsePublishedHarnessArgs(argv: readonly string[]): PublishedHarnessOptions;
export function assertScenarioCoverage(packageNames: readonly string[]): void;
export function parseNpmViewMetadata(specifier: string, stdout: string): RegistryPackageMetadata;
export function resolveRegistryPackage(
  name: string,
  selector: string,
  attempts?: number
): Promise<RegistryPackageMetadata>;
export function verifyRegistryInstallation(
  consumerRoot: string,
  packages: readonly RegistryPackageMetadata[]
): Promise<readonly (RegistryPackageMetadata & { readonly path: string })[]>;
export function percentile(values: readonly number[], fraction: number): number;
export function summarizeSamples(values: readonly number[]): {
  readonly median: number;
  readonly p95: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly samples: readonly number[];
};

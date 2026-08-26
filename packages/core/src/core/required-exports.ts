import type { GhosttyDeclaredExports } from './exports.js';
import requiredExportKinds from './required-exports.json' with { type: 'json' };

export type RequiredExportKind = 'function' | 'memory' | 'table';
export interface WasmExportDescriptor {
  readonly name: string;
  readonly kind: string;
}

type DeclaredName = keyof GhosttyDeclaredExports;
type ManifestName = keyof typeof requiredExportKinds;
type NamesMatch = Exclude<DeclaredName, ManifestName> extends never
  ? Exclude<ManifestName, DeclaredName> extends never
    ? true
    : false
  : false;
const manifestMatchesDeclarations: NamesMatch = true;
void manifestMatchesDeclarations;

export const REQUIRED_GHOSTTY_EXPORTS = Object.freeze(
  Object.entries(requiredExportKinds) as ReadonlyArray<readonly [ManifestName, RequiredExportKind]>
);

export function validateModuleExportDescriptors(
  descriptors: readonly WasmExportDescriptor[]
): string[] {
  const actual = new Map(descriptors.map(({ kind, name }) => [name, kind]));
  return validateKinds((name) => actual.get(name));
}

export function validateInstanceExports(exports: WebAssembly.Exports): string[] {
  return validateKinds((name) => instanceKind(exports[name]));
}

function validateKinds(actualKind: (name: string) => string | undefined): string[] {
  const problems: string[] = [];
  for (const [name, expected] of REQUIRED_GHOSTTY_EXPORTS) {
    const actual = actualKind(name);
    if (!actual) problems.push(`${name} is missing (expected ${expected})`);
    else if (actual !== expected) problems.push(`${name} is ${actual} (expected ${expected})`);
  }
  return problems;
}

function instanceKind(value: WebAssembly.ExportValue | undefined): string | undefined {
  if (typeof value === 'function') return 'function';
  if (value instanceof WebAssembly.Memory) return 'memory';
  if (value instanceof WebAssembly.Table) return 'table';
  if (value instanceof WebAssembly.Global) return 'global';
  return value === undefined ? undefined : typeof value;
}

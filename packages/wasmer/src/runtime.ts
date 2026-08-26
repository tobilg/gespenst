import { unwrapWasmerDirectory } from './directory.js';
import { loadWasmerSdk } from './sdk.js';
import { createManagedWasmerSession } from './session.js';
import type {
  CreateWasmerShellOptions,
  WasmerBytesPackageSource,
  WasmerProcessInstance,
  WasmerShellSession,
  WasmerUrlPackageSource,
  WasmerWasmPackageSource,
} from './types.js';

interface Freeable {
  free(): void;
}

interface CommandHandle {
  run(options?: unknown): Promise<WasmerProcessInstance>;
}

interface PackageHandle extends Freeable {
  readonly entrypoint?: CommandHandle;
  readonly commands: Record<string, CommandHandle>;
}

/** Loads a Wasmer package, starts its entrypoint or a named command, and returns a managed session. */
export async function createWasmerShell(
  options: CreateWasmerShellOptions
): Promise<WasmerShellSession> {
  const sdk = await loadWasmerSdk(options.initialization);
  const runtime = options.runtime ? new sdk.Runtime({ ...options.runtime }) : undefined;
  let packageHandle: PackageHandle | undefined;
  try {
    packageHandle = (await loadPackage(sdk, options.package, runtime)) as PackageHandle;
    const command = options.command
      ? packageHandle.commands[options.command]
      : packageHandle.entrypoint;
    if (!command) {
      const available = Object.keys(packageHandle.commands);
      const target = options.command ? `command ${JSON.stringify(options.command)}` : 'entrypoint';
      throw new Error(
        `Wasmer package has no ${target}. Available commands: ${available.join(', ') || '<none>'}`
      );
    }
    const mount = options.mount
      ? Object.fromEntries(
          Object.entries(options.mount).map(([path, value]) => [
            path,
            isWasmerDirectory(value) ? unwrapWasmerDirectory(value) : { ...value },
          ])
        )
      : undefined;
    const instance = await command.run({
      ...(options.args === undefined ? {} : { args: [...options.args] }),
      env: {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...options.env,
      },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(mount === undefined ? {} : { mount }),
      ...(options.uses === undefined ? {} : { uses: [...options.uses] }),
    });
    const ownedPackage = packageHandle;
    packageHandle = undefined;
    return createManagedWasmerSession(instance, () => {
      ownedPackage.free();
      runtime?.free();
    });
  } catch (error) {
    packageHandle?.free();
    runtime?.free();
    throw error;
  }
}

async function loadPackage(
  sdk: Awaited<ReturnType<typeof loadWasmerSdk>>,
  source: CreateWasmerShellOptions['package'],
  runtime: InstanceType<typeof sdk.Runtime> | undefined
): Promise<unknown> {
  if (source.type === 'registry') return sdk.Wasmer.fromRegistry(source.specifier, runtime);
  if (source.type === 'wasm') return sdk.Wasmer.fromWasm(copyPackageBytes(source), runtime);
  const bytes = source.type === 'url' ? await fetchPackage(source) : copyPackageBytes(source);
  return sdk.Wasmer.fromFile(bytes, runtime);
}

async function fetchPackage(source: WasmerUrlPackageSource): Promise<Uint8Array> {
  const fetchImplementation = source.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new Error('No fetch implementation is available for Wasmer URL');
  const response = await fetchImplementation(source.url);
  if (!response.ok)
    throw new Error(`Failed to load Wasmer package (${response.status}) from ${response.url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function copyPackageBytes(source: WasmerBytesPackageSource | WasmerWasmPackageSource): Uint8Array {
  return source.data instanceof Uint8Array
    ? source.data.slice()
    : new Uint8Array(source.data.slice(0));
}

function isWasmerDirectory(value: unknown): value is import('./types').WasmerDirectory {
  return typeof value === 'object' && value !== null && 'dispose' in value && 'readFile' in value;
}

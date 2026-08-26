import { type AbiManifest, GhosttyAbi, UnsupportedGhosttyAbiError } from './abi.js';
import type { CallbackBridgeExports, GhosttyExports } from './exports.js';
import { validateInstanceExports, validateModuleExportDescriptors } from './required-exports.js';
import type { WasmSource } from './types.js';

/** Default Ghostty VT WASM URL emitted and rewritten by consumer bundlers. */
export const DEFAULT_WASM_URL = new URL('../assets/ghostty-vt.wasm', import.meta.url);
/** Default callback bridge WASM URL emitted and rewritten by consumer bundlers. */
export const DEFAULT_CALLBACKS_URL = new URL('../assets/ghostty-callbacks.wasm', import.meta.url);

const urlModules = new Map<string, Promise<WebAssembly.Module>>();
const byteModules = new WeakMap<ArrayBuffer, Promise<WebAssembly.Module>>();

async function compileResponse(response: Response): Promise<WebAssembly.Module> {
  if (!response.ok)
    throw new Error(`Failed to load WASM (${response.status}) from ${response.url}`);
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(response.clone());
    } catch {
      // Servers often omit application/wasm. Buffered compilation is the portable fallback.
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

async function sourceToModule(source: WasmSource): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source;

  if (source instanceof Response) {
    return compileResponse(source);
  }
  if (source instanceof ArrayBuffer) {
    let compiled = byteModules.get(source);
    if (!compiled) {
      compiled = WebAssembly.compile(source);
      byteModules.set(source, compiled);
    }
    return compiled;
  }
  if (source instanceof Uint8Array) {
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    const exact = copy.buffer;
    let compiled = byteModules.get(exact);
    if (!compiled) {
      compiled = WebAssembly.compile(exact);
      byteModules.set(exact, compiled);
    }
    return compiled;
  }

  const url = source instanceof URL ? source : new URL(source, import.meta.url);
  const key = url.href;
  let compiled = urlModules.get(key);
  if (!compiled) {
    compiled = (async () => {
      if (url.protocol === 'file:') {
        const [{ readFile }, { fileURLToPath }] = await Promise.all([
          import(/* @vite-ignore */ 'node:fs/promises'),
          import(/* @vite-ignore */ 'node:url'),
        ]);
        const file = await readFile(fileURLToPath(url));
        const copy = new Uint8Array(file.byteLength);
        copy.set(file);
        return WebAssembly.compile(copy.buffer);
      }
      return compileResponse(await fetch(url));
    })();
    urlModules.set(key, compiled);
    compiled.catch(() => urlModules.delete(key));
  }
  return compiled;
}

/**
 * Compiles and caches the Ghostty WASM module without creating a terminal.
 *
 * @remarks
 * URL sources share an in-flight and completed compilation by URL. Reusing the same `ArrayBuffer`
 * identity also reuses compilation. Use this function when application startup needs an explicit
 * WASM-ready boundary before creating terminals.
 */
export async function preloadGhostty(
  source: WasmSource = DEFAULT_WASM_URL
): Promise<WebAssembly.Module> {
  return sourceToModule(source);
}

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end === bytes.length) throw new UnsupportedGhosttyAbiError('Unterminated ABI manifest');
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

/** Validated result returned by {@link loadGhostty}. */
export interface LoadedGhostty {
  /** Compiled Ghostty WebAssembly module. */
  readonly module: WebAssembly.Module;
  /** Instantiated module without host imports. */
  readonly instance: WebAssembly.Instance;
  /** Typed low-level Ghostty exports. */
  readonly exports: GhosttyExports;
  /** Validated ABI manifest accessor. */
  readonly abi: GhosttyAbi;
}

/** Loads, validates, and instantiates a Ghostty VT WASM module. */
export async function loadGhostty(source: WasmSource = DEFAULT_WASM_URL): Promise<LoadedGhostty> {
  const module = await sourceToModule(source);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    throw new UnsupportedGhosttyAbiError('The official Ghostty WASM must not contain imports');
  }
  const moduleProblems = validateModuleExportDescriptors(WebAssembly.Module.exports(module));
  if (moduleProblems.length > 0) {
    throw new UnsupportedGhosttyAbiError(
      `Invalid Ghostty WASM exports: ${moduleProblems.join('; ')}`
    );
  }
  const instance = await WebAssembly.instantiate(module);
  const instanceProblems = validateInstanceExports(instance.exports);
  if (instanceProblems.length > 0) {
    throw new UnsupportedGhosttyAbiError(
      `Invalid instantiated Ghostty WASM exports: ${instanceProblems.join('; ')}`
    );
  }
  const exports = instance.exports as GhosttyExports;
  const manifest = JSON.parse(
    readCString(exports.memory, exports.ghostty_type_json())
  ) as AbiManifest;
  return { module, instance, exports, abi: new GhosttyAbi(manifest) };
}

export interface CallbackHost {
  write_pty(terminal: number, userdata: number, data: number, length: number): void;
  bell(terminal: number, userdata: number): void;
  title_changed(terminal: number, userdata: number): void;
  pwd_changed(terminal: number, userdata: number): void;
  desktop_notification(terminal: number, userdata: number, request: number): void;
  progress_report(terminal: number, userdata: number, report: number): void;
  clipboard_read(terminal: number, userdata: number, request: number): void;
  clipboard_write(terminal: number, userdata: number, request: number): void;
  mime_reader(userdata: number, mime: number, writer: number): number;
  random_secure(userdata: number, buffer: number, length: number): number;
  color_scheme(terminal: number, userdata: number, outScheme: number): number;
}

/** Instantiates the callback bridge with host functions used by Ghostty terminals. */
export async function loadCallbackBridge(
  host: CallbackHost,
  source: WasmSource = DEFAULT_CALLBACKS_URL
): Promise<CallbackBridgeExports> {
  const module = await sourceToModule(source);
  const instance = await WebAssembly.instantiate(module, {
    host: host as unknown as WebAssembly.ModuleImports,
  });
  return instance.exports as CallbackBridgeExports;
}

export { sourceToModule };

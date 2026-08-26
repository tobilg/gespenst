import { GhosttyBindings } from './bindings.js';
import type { CallbackBridgeExports } from './exports.js';
import { loadCallbackBridge, loadGhostty } from './loader.js';
import { CoreTerminal, type TerminalHost } from './terminal.js';
import type {
  ClipboardWriteRequest,
  CoreRuntimeOptions,
  CoreTerminalOptions,
  ProgressState,
} from './types.js';

type CallbackIndexes = TerminalHost['callbackIndexes'];

function tableFunction(
  exports: CallbackBridgeExports,
  name: keyof CallbackBridgeExports
): (...args: number[]) => number | undefined {
  const value = exports[name];
  if (typeof value !== 'function')
    throw new Error(`Callback bridge export ${String(name)} is not a function`);
  return value as (...args: number[]) => number | undefined;
}

function installCallbacks(
  table: WebAssembly.Table,
  bridge: CallbackBridgeExports
): CallbackIndexes {
  const install = (name: keyof CallbackBridgeExports): number => {
    const index = table.grow(1);
    table.set(index, tableFunction(bridge, name) as never);
    return index;
  };
  return {
    writePty: install('write_pty'),
    bell: install('bell'),
    titleChanged: install('title_changed'),
    pwdChanged: install('pwd_changed'),
    desktopNotification: install('desktop_notification'),
    progressReport: install('progress_report'),
    clipboardRead: install('clipboard_read'),
    clipboardWrite: install('clipboard_write'),
    mimeReader: install('mime_reader'),
    randomSecure: install('random_secure'),
    colorScheme: install('color_scheme'),
  };
}

const PROGRESS_STATES: readonly ProgressState[] = [
  'remove',
  'set',
  'error',
  'indeterminate',
  'pause',
];

/**
 * Shared headless Ghostty WASM runtime that creates and owns terminal instances.
 *
 * @remarks
 * Reuse one runtime for independent headless sessions so they share the loaded and compiled Ghostty
 * module. Disposing the runtime disposes every terminal it created.
 */
export class CoreRuntime implements TerminalHost {
  private readonly terminals = new Map<number, CoreTerminal>();
  private nextId = 1;
  private disposed = false;
  /** @internal */
  readonly bindings: GhosttyBindings;
  /** @internal */
  readonly callbackIndexes: CallbackIndexes;
  /** Compiled Ghostty module shared by terminals created from this runtime. */
  readonly wasmModule: WebAssembly.Module;

  private constructor(
    bindings: GhosttyBindings,
    callbackIndexes: CallbackIndexes,
    wasmModule: WebAssembly.Module
  ) {
    this.bindings = bindings;
    this.callbackIndexes = callbackIndexes;
    this.wasmModule = wasmModule;
  }

  /**
   * Creates and initializes a runtime from optional custom WASM sources.
   *
   * @remarks The Ghostty artifact is validated against its self-described ABI before this resolves.
   */
  static async create(options: CoreRuntimeOptions = {}): Promise<CoreRuntime> {
    const loaded = await loadGhostty(options.wasm);
    const bindings = new GhosttyBindings(loaded.exports, loaded.abi);
    let runtime: CoreRuntime | null = null;
    const safely = (userdata: number, action: (terminal: CoreTerminal) => void): void => {
      const terminal = runtime?.terminals.get(userdata);
      if (!terminal) return;
      try {
        action(terminal);
      } catch (error) {
        terminal.queueEffect({
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    };
    const bridge = await loadCallbackBridge(
      {
        write_pty(_terminal, userdata, data, length) {
          safely(userdata, (target) =>
            target.queueEffect({ type: 'input', data: bindings.copyBytes(data, length) })
          );
        },
        bell(_terminal, userdata) {
          safely(userdata, (target) => target.queueEffect({ type: 'bell' }));
        },
        title_changed(_terminal, userdata) {
          safely(userdata, (target) => target.queueEffect({ type: 'title' }));
        },
        pwd_changed(_terminal, userdata) {
          safely(userdata, (target) => target.queueEffect({ type: 'cwd' }));
        },
        desktop_notification(_terminal, userdata, request) {
          safely(userdata, (target) => {
            const abi = bindings.abi;
            target.queueEffect({
              type: 'notification',
              title: bindings.readStringStruct(
                request + abi.field('GhosttyTerminalDesktopNotification', 'title').offset
              ),
              body: bindings.readStringStruct(
                request + abi.field('GhosttyTerminalDesktopNotification', 'body').offset
              ),
            });
          });
        },
        progress_report(_terminal, userdata, report) {
          safely(userdata, (target) => {
            const abi = bindings.abi;
            const view = new DataView(bindings.exports.memory.buffer);
            const stateValue = view.getInt32(
              report + abi.field('GhosttyTerminalProgressReport', 'state').offset,
              true
            );
            const progressValue = view.getInt8(
              report + abi.field('GhosttyTerminalProgressReport', 'progress').offset
            );
            target.queueEffect({
              type: 'progress',
              state: PROGRESS_STATES[stateValue] ?? 'remove',
              progress: progressValue < 0 ? null : progressValue,
            });
          });
        },
        clipboard_read(_terminal, userdata, request) {
          safely(userdata, (target) => target.replyClipboardRead(request));
        },
        clipboard_write(_terminal, userdata, request) {
          safely(userdata, (target) =>
            target.replyClipboardWrite(request, readClipboard(bindings, request))
          );
        },
        mime_reader() {
          return 0;
        },
        random_secure(_userdata, buffer, length) {
          try {
            if (!globalThis.crypto?.getRandomValues) return 0;
            const bytes = new Uint8Array(bindings.exports.memory.buffer, buffer, length);
            for (let offset = 0; offset < bytes.length; offset += 65_536) {
              globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
            }
            return 1;
          } catch {
            return 0;
          }
        },
        color_scheme(_terminal, userdata, outScheme) {
          return runtime?.terminals.get(userdata)?.writeColorScheme(outScheme) ?? 0;
        },
      },
      options.callbacksWasm
    );
    runtime = new CoreRuntime(
      bindings,
      installCallbacks(loaded.exports.__indirect_function_table, bridge),
      loaded.module
    );
    bindings.check(
      bindings.exports.ghostty_sys_set(
        bindings.abi.value('GhosttySysOption', 'RANDOM_SECURE'),
        runtime.callbackIndexes.randomSecure
      ),
      'install secure random provider'
    );
    return runtime;
  }

  /**
   * Creates a headless terminal owned by this runtime.
   *
   * @remarks The default grid is 80 by 24 cells with 10,000 lines of scrollback.
   */
  createTerminal(options: CoreTerminalOptions = {}): CoreTerminal {
    if (this.disposed) throw new Error('CoreRuntime is disposed');
    const id = this.nextId++;
    const terminal = new CoreTerminal(this, id, options);
    this.terminals.set(id, terminal);
    return terminal;
  }

  /** @internal */
  unregister(id: number): void {
    this.terminals.delete(id);
  }

  /** Disposes every owned terminal and prevents further terminal creation. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const terminal of [...this.terminals.values()]) terminal.dispose();
    this.terminals.clear();
  }
}

function readClipboard(bindings: GhosttyBindings, request: number): ClipboardWriteRequest {
  const abi = bindings.abi;
  const view = new DataView(bindings.exports.memory.buffer);
  const locationValue = view.getInt32(
    request + abi.field('GhosttyClipboardWrite', 'location').offset,
    true
  );
  const contents = view.getUint32(
    request + abi.field('GhosttyClipboardWrite', 'contents').offset,
    true
  );
  const length = view.getUint32(
    request + abi.field('GhosttyClipboardWrite', 'contents_len').offset,
    true
  );
  const itemSize = abi.size('GhosttyClipboardContent');
  const mimeOffset = abi.field('GhosttyClipboardContent', 'mime').offset;
  const dataOffset = abi.field('GhosttyClipboardContent', 'data').offset;
  return {
    location: locationValue === 1 ? 'selection' : locationValue === 2 ? 'primary' : 'standard',
    contents: Array.from({ length }, (_, index) => {
      const item = contents + index * itemSize;
      const dataStruct = item + dataOffset;
      const pointer = view.getUint32(dataStruct + abi.field('GhosttyString', 'ptr').offset, true);
      const byteLength = view.getUint32(
        dataStruct + abi.field('GhosttyString', 'len').offset,
        true
      );
      return {
        mime: bindings.readStringStruct(item + mimeOffset),
        data: bindings.copyBytes(pointer, byteLength),
      };
    }),
    name: bindings.readStringStruct(request + abi.field('GhosttyClipboardWrite', 'name').offset),
    granted: view.getUint8(request + abi.field('GhosttyClipboardWrite', 'granted').offset) !== 0,
    canRemember:
      view.getUint8(request + abi.field('GhosttyClipboardWrite', 'can_remember').offset) !== 0,
  };
}

/** Creates and initializes a shared headless Ghostty runtime. */
export function createCoreRuntime(options?: CoreRuntimeOptions): Promise<CoreRuntime> {
  return CoreRuntime.create(options);
}

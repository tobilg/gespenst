import type * as BashKit from '@everruns/bashkit-wasm';
import { createManagedBashKitSession } from './session.js';
import type { BashKitShellSession, BashKitWasmSource, CreateBashKitShellOptions } from './types.js';

let initialization: Promise<typeof BashKit> | undefined;
let initializationSource: BashKitWasmSource | undefined;

/** Initializes BashKit and creates one stateful, terminal-compatible interpreter session. */
export async function createBashKitShell(
  options: CreateBashKitShellOptions = {}
): Promise<BashKitShellSession> {
  const sdk = await initializeBashKit(options.wasm);
  const bash = new sdk.Bash({ profile: 'interactive', ...options.bash });
  return createManagedBashKitSession({
    bash,
    executor: {
      execute: (command, onOutput) => bash.executeWithOutput(command, onOutput),
      cancel: () => bash.cancel(),
      clearCancel: () => bash.clearCancel(),
    },
    prompt: options.prompt ?? 'bash $ ',
    historyLimit: Math.max(0, Math.trunc(options.historyLimit ?? 100)),
    maxBufferedOutputBytes: Math.max(1, Math.trunc(options.maxBufferedOutputBytes ?? 1024 * 1024)),
  });
}

async function initializeBashKit(source?: BashKitWasmSource): Promise<typeof BashKit> {
  if (initialization && source !== initializationSource) {
    throw new Error('BashKit was already initialized with a different WebAssembly source');
  }
  if (!initialization) {
    initializationSource = source;
    initialization = import('@everruns/bashkit-wasm').then(async (sdk) => {
      await sdk.initBashkit(source);
      return sdk;
    });
    initialization.catch(() => {
      initialization = undefined;
      initializationSource = undefined;
    });
  }
  return initialization;
}

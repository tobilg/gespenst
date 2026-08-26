import { createTransportBridge } from './transport.js';
import type {
  WasmerProcessInstance,
  WasmerShellCapabilities,
  WasmerShellSession,
  WasmerShellStatus,
} from './types.js';

const SESSION_CAPABILITIES: WasmerShellCapabilities = Object.freeze({
  interactiveInput: true,
  filesystem: true,
  subprocesses: true,
  resize: false,
});

/**
 * Creates a managed terminal session around an already-running Wasmer process. This consumes the
 * instance through its `wait()` operation.
 */
export function createWasmerSession(instance: WasmerProcessInstance): WasmerShellSession {
  return createManagedWasmerSession(instance);
}

export function createManagedWasmerSession(
  instance: WasmerProcessInstance,
  cleanup: () => void = () => undefined
): WasmerShellSession {
  const interactiveInput = instance.stdin !== undefined;
  const bridge = createTransportBridge(instance);
  const listeners = new Set<(status: WasmerShellStatus) => void>();
  let status: WasmerShellStatus = 'running';
  let sessionError: Error | undefined;
  let disposed = false;
  let cleaned = false;
  const setStatus = (value: WasmerShellStatus) => {
    if (status === value) return;
    status = value;
    for (const listener of [...listeners]) listener(value);
  };
  const release = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  const exit = instance.wait().then(
    (output) => {
      if (!disposed) setStatus('exited');
      void bridge.closeInput().catch(() => undefined);
      return output;
    },
    (reason: unknown) => {
      const error = asError(reason);
      sessionError = error;
      if (!disposed) setStatus('error');
      throw error;
    }
  );
  void exit.catch(() => undefined);

  return {
    transport: bridge.transport,
    capabilities: Object.freeze({
      ...SESSION_CAPABILITIES,
      interactiveInput,
    }),
    get status() {
      return status;
    },
    get error() {
      return sessionError;
    },
    exit,
    async close() {
      if (disposed) throw new Error('WasmerShellSession is disposed');
      if (status === 'running') setStatus('closing');
      await bridge.closeInput();
      return exit;
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setStatus('disposed');
      void bridge.abortInput('Wasmer session disposed').catch(() => undefined);
      void bridge.cancelOutput('Wasmer session disposed').catch(() => undefined);
      listeners.clear();
      release();
    },
  };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

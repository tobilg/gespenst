import type { Bash, BashOptions } from '@everruns/bashkit-wasm';
import type {
  Disposable,
  TerminalConnection,
  TerminalConnectionOptions,
  TerminalTransport,
} from '@gespenst/core';

/** WebAssembly source accepted by BashKit initialization. */
export type BashKitWasmSource = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

/** Options used to create one stateful BashKit browser shell. */
export interface CreateBashKitShellOptions {
  /** BashKit interpreter configuration. The `interactive` profile is used by default. */
  readonly bash?: BashOptions;
  /** Custom BashKit WebAssembly source for self-hosted deployments. */
  readonly wasm?: BashKitWasmSource;
  /** Static prompt drawn by the terminal-side line editor. @defaultValue `'bash $ '` */
  readonly prompt?: string;
  /** Maximum retained command-history entries. @defaultValue `100` */
  readonly historyLimit?: number;
  /** Maximum output bytes waiting behind terminal backpressure. @defaultValue `1048576` */
  readonly maxBufferedOutputBytes?: number;
}

/** Lifecycle states of a managed BashKit shell session. */
export type BashKitShellStatus = 'running' | 'closing' | 'exited' | 'error' | 'disposed';

/** Reason a BashKit shell's exit promise settled normally. */
export type BashKitShellExitReason = 'exit' | 'closed' | 'disposed';

/** Final status of a BashKit shell session. */
export interface BashKitShellExit {
  /** Bash-compatible exit code. */
  readonly code: number;
  /** Operation that ended the session. */
  readonly reason: BashKitShellExitReason;
}

/** Runtime features exposed by a BashKit session. */
export interface BashKitShellCapabilities {
  /** Whether terminal input can execute commands. */
  readonly interactiveInput: true;
  /** Whether the interpreter exposes a stateful virtual filesystem. */
  readonly filesystem: true;
  /** BashKit does not launch operating-system child processes. */
  readonly subprocesses: false;
  /** BashKit cannot execute arbitrary external WASI modules. */
  readonly arbitraryWasiModules: false;
  /** BashKit does not expose PTY window-size updates. */
  readonly resize: false;
  /** BashKit is single-threaded and does not require cross-origin isolation. */
  readonly crossOriginIsolation: false;
}

/** Managed byte streams and lifecycle for a stateful BashKit interpreter. */
export interface BashKitShellSession extends Disposable {
  /** Terminal-compatible byte streams. They may be connected once. */
  readonly transport: TerminalTransport;
  /** Underlying BashKit instance for advanced filesystem and snapshot operations. */
  readonly bash: Bash;
  /** Features callers may use to distinguish BashKit from process-backed shells. */
  readonly capabilities: BashKitShellCapabilities;
  /** Current lifecycle state. */
  readonly status: BashKitShellStatus;
  /** Fatal stream or lifecycle error, when status is `error`. */
  readonly error: Error | undefined;
  /** Settles for exit commands, graceful closure, disposal, and fatal errors. */
  readonly exit: Promise<BashKitShellExit>;
  /** Cancels an active command and closes the session after it settles. */
  close(): Promise<BashKitShellExit>;
  /** Subscribes to lifecycle transitions. */
  onStatusChange(listener: (status: BashKitShellStatus) => void): Disposable;
}

/** Result produced after a {@link BashKitAddon} attaches to a terminal. */
export interface BashKitAddonReady {
  /** Managed BashKit session. */
  readonly session: BashKitShellSession;
  /** Active native terminal transport connection. */
  readonly connection: TerminalConnection;
}

/** Configuration for a BashKit-backed terminal addon. */
export interface BashKitAddonOptions extends CreateBashKitShellOptions {
  /** Backpressure and cancellation policy passed to the native terminal connection. */
  readonly connection?: TerminalConnectionOptions;
}

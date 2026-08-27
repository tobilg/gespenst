import type { BashKitAddonOptions, BashKitShellSession } from '@gespenst/bashkit';
import type { Disposable, TerminalConnection, TerminalConnectionOptions } from '@gespenst/core';

/** Runtime currently used by the stable browser-shell facade. */
export type BrowserShellBackend = 'bashkit';

/** Lifecycle states emitted by {@link BrowserShellAddon}. */
export type BrowserShellStatus = 'idle' | 'starting' | 'ready' | 'exited' | 'error' | 'disposed';

/** Progress notification emitted while a browser shell starts and runs. */
export interface BrowserShellStatusEvent {
  /** Current addon lifecycle state. */
  readonly status: BrowserShellStatus;
  /** Active implementation after startup begins. */
  readonly backend?: BrowserShellBackend;
  /** Fatal startup or runtime failure. */
  readonly error?: Error;
}

/** Configuration for a portable browser shell. */
export interface BrowserShellAddonOptions {
  /** BashKit-specific interpreter configuration. */
  readonly bashkit?: Omit<BashKitAddonOptions, 'connection'>;
  /** Backpressure and cancellation policy used by the terminal connection. */
  readonly connection?: TerminalConnectionOptions;
}

/** Successful BashKit-backed browser shell startup. */
export interface BrowserShellBashKitReady {
  /** Active implementation discriminator retained for future extensibility. */
  readonly backend: 'bashkit';
  /** Managed BashKit interpreter session. */
  readonly session: BashKitShellSession;
  /** Active native terminal transport connection. */
  readonly connection: TerminalConnection;
}

/** Runtime-specific session selected by {@link BrowserShellAddon}. */
export type BrowserShellReady = BrowserShellBashKitReady;

/** Public lifecycle exposed by a browser shell addon. */
export interface BrowserShellLifecycle extends Disposable {
  /** Settles after the interpreter starts and connects to the terminal. */
  readonly ready: Promise<BrowserShellReady>;
  /** Current addon lifecycle state. */
  readonly status: BrowserShellStatus;
  /** Active implementation after startup begins. */
  readonly backend: BrowserShellBackend | undefined;
  /** Fatal startup or runtime failure. */
  readonly error: Error | undefined;
  /** Subscribes to structured lifecycle progress. */
  onStatusChange(listener: (event: BrowserShellStatusEvent) => void): Disposable;
}

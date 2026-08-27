import type { BashKitAddon } from '@gespenst/bashkit';
import type { BrowserTerminal, Disposable, TerminalAddon } from '@gespenst/core';
import type {
  BrowserShellAddonOptions,
  BrowserShellBackend,
  BrowserShellReady,
  BrowserShellStatus,
  BrowserShellStatusEvent,
} from './types.js';

/** Starts a portable BashKit shell behind Gespenst's stable browser-shell facade. */
export class BrowserShellAddon implements TerminalAddon {
  /** Resolves after the interpreter starts and its byte streams are connected. */
  readonly ready: Promise<BrowserShellReady>;
  private resolveReady!: (ready: BrowserShellReady) => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private terminal: BrowserTerminal | null = null;
  private runtimeAddon: BashKitAddon | null = null;
  private disposed = false;
  private statusValue: BrowserShellStatus = 'idle';
  private backendValue: BrowserShellBackend | undefined;
  private errorValue: Error | undefined;
  private readonly listeners = new Set<(event: BrowserShellStatusEvent) => void>();
  private readonly options: BrowserShellAddonOptions;

  /** Creates a shell without loading BashKit until terminal activation. */
  constructor(options: BrowserShellAddonOptions = {}) {
    this.options = options;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** Current shell lifecycle state. */
  get status(): BrowserShellStatus {
    return this.statusValue;
  }

  /** Selected implementation after startup begins. */
  get backend(): BrowserShellBackend | undefined {
    return this.backendValue;
  }

  /** Fatal startup or runtime failure. */
  get error(): Error | undefined {
    return this.errorValue;
  }

  /** Subscribes to structured shell lifecycle progress. */
  onStatusChange(listener: (event: BrowserShellStatusEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Loads and attaches the browser shell to a terminal. */
  activate(terminal: BrowserTerminal): void {
    if (this.terminal) throw new Error('BrowserShellAddon is already active');
    if (this.disposed) throw new Error('BrowserShellAddon is disposed');
    this.terminal = terminal;
    void this.start();
  }

  /** Releases the interpreter and rejects startup if it is still pending. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runtimeAddon?.dispose();
    this.runtimeAddon = null;
    this.terminal = null;
    if (!this.readySettled) {
      this.readySettled = true;
      const error = new Error('BrowserShellAddon was disposed before the shell became ready');
      error.name = 'AbortError';
      this.rejectReady(error);
    }
    this.emit({ status: 'disposed', ...(this.backendValue ? { backend: this.backendValue } : {}) });
    this.listeners.clear();
  }

  private async start(): Promise<void> {
    const terminal = this.activeTerminal();
    this.backendValue = 'bashkit';
    this.emit({ status: 'starting', backend: 'bashkit' });
    try {
      const { BashKitAddon } = await import('@gespenst/bashkit');
      if (this.disposed || terminal !== this.terminal) return;
      const addon = new BashKitAddon({
        ...this.options.bashkit,
        ...(this.options.connection ? { connection: this.options.connection } : {}),
      });
      this.runtimeAddon = addon;
      addon.activate(terminal);
      const ready = await addon.ready;
      if (this.disposed || terminal !== this.terminal) {
        addon.dispose();
        return;
      }
      const result: BrowserShellReady = { backend: 'bashkit', ...ready };
      this.resolve(result);
      this.observeExit(ready.session.exit);
    } catch (reason) {
      if (this.disposed) return;
      this.runtimeAddon?.dispose();
      this.runtimeAddon = null;
      const error = asError(reason);
      this.errorValue = error;
      this.emit({ status: 'error', backend: 'bashkit', error });
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(error);
      }
    }
  }

  private resolve(ready: BrowserShellReady): void {
    if (this.readySettled || this.disposed) return;
    this.readySettled = true;
    this.emit({ status: 'ready', backend: ready.backend });
    this.resolveReady(ready);
  }

  private observeExit(exit: Promise<unknown>): void {
    void exit.then(
      () => {
        if (!this.disposed) this.emit({ status: 'exited', backend: 'bashkit' });
      },
      (reason: unknown) => {
        if (this.disposed) return;
        const error = asError(reason);
        this.errorValue = error;
        this.emit({ status: 'error', backend: 'bashkit', error });
      }
    );
  }

  private activeTerminal(): BrowserTerminal {
    if (!this.terminal || this.disposed) {
      const error = new Error('BrowserShellAddon is no longer active');
      error.name = 'AbortError';
      throw error;
    }
    return this.terminal;
  }

  private emit(event: BrowserShellStatusEvent): void {
    this.statusValue = event.status;
    for (const listener of [...this.listeners]) listener(event);
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

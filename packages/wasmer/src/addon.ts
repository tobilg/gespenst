import type { BrowserTerminal, TerminalAddon, TerminalConnection } from '@gespenst/core';
import { createWasmerShell } from './runtime.js';
import type { WasmerAddonOptions, WasmerAddonReady, WasmerShellSession } from './types.js';

/** Browser-terminal addon that starts and attaches a Wasmer WASIX shell. */
export class WasmerAddon implements TerminalAddon {
  /** Resolves after the shell starts and its byte streams are connected. */
  readonly ready: Promise<WasmerAddonReady>;
  private resolveReady!: (ready: WasmerAddonReady) => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private terminal: BrowserTerminal | null = null;
  private session: WasmerShellSession | null = null;
  private connection: TerminalConnection | null = null;
  private disposed = false;
  private readonly options: WasmerAddonOptions;

  /** Creates an addon without starting Wasmer until terminal activation. */
  constructor(options: WasmerAddonOptions) {
    this.options = options;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** Starts the Wasmer shell and connects it to the activating terminal. */
  activate(terminal: BrowserTerminal): void {
    if (this.terminal) throw new Error('WasmerAddon is already active');
    if (this.disposed) throw new Error('WasmerAddon is disposed');
    this.terminal = terminal;
    void this.start();
  }

  /** Releases the terminal connection and Wasmer process resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection?.dispose();
    this.connection = null;
    this.session?.dispose();
    this.session = null;
    this.terminal = null;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new Error('WasmerAddon was disposed before the shell started'));
    }
  }

  private async start(): Promise<void> {
    let session: WasmerShellSession | null = null;
    try {
      const terminal = this.terminal;
      if (!terminal || this.disposed) return;
      session = await createWasmerShell(this.options);
      if (this.disposed || terminal !== this.terminal) {
        session.dispose();
        return;
      }
      const connection = terminal.connect(session.transport, this.options.connection);
      this.session = session;
      this.connection = connection;
      this.readySettled = true;
      this.resolveReady({ session, connection });
    } catch (reason) {
      session?.dispose();
      const error = reason instanceof Error ? reason : new Error(String(reason));
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(error);
      }
    }
  }
}

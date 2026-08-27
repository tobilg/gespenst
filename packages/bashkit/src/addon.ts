import type { BrowserTerminal, TerminalAddon, TerminalConnection } from '@gespenst/core';
import { createBashKitShell } from './runtime.js';
import type { BashKitAddonOptions, BashKitAddonReady, BashKitShellSession } from './types.js';

/** Browser-terminal addon backed by a single-process BashKit interpreter. */
export class BashKitAddon implements TerminalAddon {
  /** Resolves after BashKit starts and its byte streams are connected. */
  readonly ready: Promise<BashKitAddonReady>;
  private resolveReady!: (ready: BashKitAddonReady) => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private terminal: BrowserTerminal | null = null;
  private session: BashKitShellSession | null = null;
  private connection: TerminalConnection | null = null;
  private disposed = false;
  private readonly options: BashKitAddonOptions;

  /** Creates an addon without loading BashKit until activation. */
  constructor(options: BashKitAddonOptions = {}) {
    this.options = options;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** Loads BashKit and connects it to the activating terminal. */
  activate(terminal: BrowserTerminal): void {
    if (this.terminal) throw new Error('BashKitAddon is already active');
    if (this.disposed) throw new Error('BashKitAddon is disposed');
    this.terminal = terminal;
    void this.start();
  }

  /** Releases the connection and interpreter resources. */
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
      const error = new Error('BashKitAddon was disposed before the shell started');
      error.name = 'AbortError';
      this.rejectReady(error);
    }
  }

  private async start(): Promise<void> {
    let session: BashKitShellSession | null = null;
    try {
      const terminal = this.terminal;
      if (!terminal || this.disposed) return;
      session = await createBashKitShell(this.options);
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

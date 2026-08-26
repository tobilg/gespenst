import type {
  BrowserTerminal,
  Disposable,
  TerminalAddon,
  TerminalConnection,
} from '@gespenst/core';

/** Default WebSocket subprotocol used by the addon and example PTY server. */
export const WEBSOCKET_PROTOCOL = 'gespenst.v1';

// WebSocket ready-state values are fixed by the WebSocket standard. Keep transport checks
// independent of the ambient constructor so custom sockets also work in Node and test runtimes.
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;

/** Observable lifecycle states for a {@link WebSocketAddon}. */
export type WebSocketAddonStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

/** Exponential-backoff policy used after an unexpected disconnect. */
export interface ReconnectOptions {
  /** Maximum reconnect attempts; defaults to unlimited. */
  readonly maxAttempts?: number;
  /** Delay before the first reconnect attempt, in milliseconds. Defaults to `250`. */
  readonly initialDelayMs?: number;
  /** Maximum delay between attempts, in milliseconds. Defaults to `10000`. */
  readonly maxDelayMs?: number;
  /** Backoff multiplier. Defaults to `2`. */
  readonly factor?: number;
}

/** Configuration for the binary WebSocket terminal transport. */
export interface WebSocketAddonOptions {
  /** WebSocket subprotocol or ordered subprotocol list. */
  readonly protocols?: string | readonly string[];
  /** Maximum queued outbound terminal bytes before backpressure is applied. */
  readonly highWaterMarkBytes?: number;
  /** Enables reconnection with defaults or a custom backoff policy. */
  readonly reconnect?: boolean | ReconnectOptions;
  /** Factory for custom, instrumented, or test WebSocket implementations. */
  readonly createSocket?: (url: string | URL, protocols: string | string[]) => WebSocket;
}

/** Byte streams produced by {@link socketTransport}. */
export interface SocketTransport {
  /** Binary PTY output received from the WebSocket. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Binary terminal input written to the WebSocket. */
  readonly writable: WritableStream<Uint8Array>;
}

/**
 * Connects a browser terminal to a binary WebSocket PTY endpoint, forwards geometry changes, and
 * optionally reconnects with exponential backoff.
 */
export class WebSocketAddon implements TerminalAddon {
  /** Resolves with the first successfully opened terminal connection. */
  readonly ready: Promise<TerminalConnection>;
  private terminal: BrowserTerminal | null = null;
  private socket: WebSocket | null = null;
  private connection: TerminalConnection | null = null;
  private resizeListener: Disposable | null = null;
  private resolveReady!: (connection: TerminalConnection) => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private statusValue: WebSocketAddonStatus = 'idle';
  private readonly listeners = new Set<(status: WebSocketAddonStatus) => void>();
  private readonly url: string | URL;
  private readonly options: WebSocketAddonOptions;
  private readonly closeEvents = new WeakMap<WebSocket, CloseEvent>();

  /** Creates an addon for `url` without opening the socket until activation. */
  constructor(url: string | URL, options: WebSocketAddonOptions = {}) {
    this.url = url;
    this.options = options;
    this.ready = new Promise<TerminalConnection>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** Current connection lifecycle state. */
  get status(): WebSocketAddonStatus {
    return this.statusValue;
  }

  /** Subscribes to connection status transitions. */
  onStatusChange(listener: (status: WebSocketAddonStatus) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Attaches the addon and begins connecting. Called by `terminal.loadAddon()`. */
  activate(terminal: BrowserTerminal): void {
    if (this.terminal) throw new Error('WebSocketAddon is already active');
    this.terminal = terminal;
    this.disposed = false;
    void this.connect(false);
  }

  /** Closes the socket and connection, cancels reconnection, and releases listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.resizeListener?.dispose();
    this.resizeListener = null;
    this.connection?.dispose();
    this.connection = null;
    this.socket?.close(1000, 'Terminal disposed');
    this.socket = null;
    this.terminal = null;
    if (!this.readySettled) {
      this.readySettled = true;
      const error = new Error('WebSocket addon disposed before opening');
      error.name = 'AbortError';
      this.rejectReady(error);
    }
    this.setStatus('closed');
    this.listeners.clear();
  }

  private async connect(reconnecting: boolean): Promise<void> {
    const terminal = this.terminal;
    if (!terminal || this.disposed) return;
    this.setStatus(reconnecting ? 'reconnecting' : 'connecting');
    let socket: WebSocket | null = null;
    try {
      const protocols = this.options.protocols ?? WEBSOCKET_PROTOCOL;
      const protocolList = typeof protocols === 'string' ? protocols : [...protocols];
      socket = this.options.createSocket
        ? this.options.createSocket(this.url, protocolList)
        : new WebSocket(this.url, protocolList);
      const activeSocket = socket;
      activeSocket.addEventListener('close', (event) => this.closeEvents.set(activeSocket, event), {
        once: true,
      });
      this.socket = activeSocket;
      activeSocket.binaryType = 'arraybuffer';
      await waitForOpen(activeSocket);
      if (this.disposed || activeSocket !== this.socket) {
        activeSocket.close(1000, 'Connection superseded');
        return;
      }
      this.attempt = 0;
      activeSocket.send(
        JSON.stringify({
          type: 'hello',
          version: 1,
          cols: terminal.geometry.cols,
          rows: terminal.geometry.rows,
        })
      );
      const connection = terminal.connect(socketTransport(activeSocket), {
        ...(this.options.highWaterMarkBytes === undefined
          ? {}
          : { highWaterMarkBytes: this.options.highWaterMarkBytes }),
      });
      this.connection = connection;
      this.resizeListener?.dispose();
      this.resizeListener = terminal.on('resize', ({ cols, rows }) => {
        if (activeSocket.readyState === SOCKET_OPEN)
          activeSocket.send(JSON.stringify({ type: 'resize', cols, rows }));
      });
      this.setStatus('connected');
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady(connection);
      }
      void connection.closed.catch(() => undefined).finally(() => this.handleClosed(activeSocket));
    } catch (error) {
      if (this.disposed || (socket && this.socket !== socket)) return;
      const value = error instanceof Error ? error : new Error(String(error));
      if (!this.scheduleReconnect()) {
        this.setStatus('error');
        if (!this.readySettled) {
          this.readySettled = true;
          this.rejectReady(value);
        }
      }
    }
  }

  private handleClosed(socket: WebSocket): void {
    if (socket !== this.socket || this.disposed) return;
    this.resizeListener?.dispose();
    this.resizeListener = null;
    this.connection = null;
    this.socket = null;
    const close = this.closeEvents.get(socket);
    const expected = close?.code === 1000 || close?.code === 1001;
    if (expected || !this.scheduleReconnect()) this.setStatus('closed');
  }

  private scheduleReconnect(): boolean {
    if (this.disposed || !this.options.reconnect) return false;
    const options = typeof this.options.reconnect === 'object' ? this.options.reconnect : {};
    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (this.attempt >= maxAttempts) return false;
    const initial = Math.max(0, options.initialDelayMs ?? 250);
    const maximum = Math.max(initial, options.maxDelayMs ?? 10_000);
    const factor = Math.max(1, options.factor ?? 2);
    const delay = Math.min(maximum, initial * factor ** this.attempt);
    this.attempt += 1;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(true);
    }, delay);
    return true;
  }

  private setStatus(status: WebSocketAddonStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    for (const listener of this.listeners) listener(status);
  }
}

/**
 * Adapts a browser `WebSocket` to the native terminal's byte-stream transport contract.
 * Binary messages become PTY output; outbound bytes are sent without text transcoding.
 */
export function socketTransport(socket: WebSocket): SocketTransport {
  let removeReadableListeners = () => {};
  let cancelReadable = (reason: unknown) => {
    removeReadableListeners();
    if (socket.readyState < SOCKET_CLOSING)
      socket.close(1000, typeof reason === 'string' ? reason : 'Terminal closed');
  };
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      let settled = false;
      let messages = Promise.resolve();
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        removeReadableListeners();
        action();
      };
      const message = (event: MessageEvent) => {
        if (settled) return;
        messages = messages
          .then(async () => {
            if (settled) return;
            if (event.data instanceof ArrayBuffer) {
              controller.enqueue(new Uint8Array(event.data));
            } else if (event.data instanceof Blob) {
              const data = await event.data.arrayBuffer();
              if (!settled) controller.enqueue(new Uint8Array(data));
            } else if (typeof event.data === 'string') {
              let control: { type?: string; message?: string };
              try {
                control = JSON.parse(event.data) as { type?: string; message?: string };
              } catch {
                throw new Error('Invalid WebSocket control message');
              }
              if (control.type === 'error') throw new Error(control.message ?? 'PTY error');
              if (control.type === 'exit') {
                if (socket.readyState < SOCKET_CLOSING) socket.close(1000, 'PTY exited');
                finish(() => controller.close());
              }
            }
          })
          .catch((error) => finish(() => controller.error(error)));
      };
      const close = () => {
        messages = messages.then(() => finish(() => controller.close()));
      };
      const error = () => {
        messages = messages.then(() =>
          finish(() => controller.error(new Error('WebSocket transport failed')))
        );
      };
      removeReadableListeners = () => {
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', close);
        socket.removeEventListener('error', error);
      };
      cancelReadable = (reason) => {
        if (settled) return;
        settled = true;
        removeReadableListeners();
        if (socket.readyState < SOCKET_CLOSING)
          socket.close(1000, typeof reason === 'string' ? reason : 'Terminal closed');
      };
      socket.addEventListener('message', message);
      socket.addEventListener('close', close);
      socket.addEventListener('error', error);
    },
    cancel(reason) {
      cancelReadable(reason);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    async write(data) {
      if (socket.readyState !== SOCKET_OPEN) throw new Error('WebSocket is not open');
      while (socket.bufferedAmount > 1024 * 1024) {
        if (socket.readyState !== SOCKET_OPEN) throw new Error('WebSocket closed while writing');
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      socket.send(data.slice().buffer);
    },
    close() {
      if (socket.readyState < SOCKET_CLOSING) socket.close(1000, 'Terminal input closed');
    },
    abort(reason) {
      if (socket.readyState < SOCKET_CLOSING)
        socket.close(1011, typeof reason === 'string' ? reason : 'Terminal input failed');
    },
  });
  return { readable, writable };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === SOCKET_OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', open);
      socket.removeEventListener('error', error);
      socket.removeEventListener('close', close);
    };
    const open = () => {
      cleanup();
      resolve();
    };
    const error = () => {
      cleanup();
      reject(new Error('WebSocket connection failed'));
    };
    const close = () => {
      cleanup();
      reject(new Error('WebSocket closed before opening'));
    };
    socket.addEventListener('open', open, { once: true });
    socket.addEventListener('error', error, { once: true });
    socket.addEventListener('close', close, { once: true });
  });
}

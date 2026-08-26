import type {
  BrowserTerminal,
  ClipboardContent,
  ClipboardLocation,
  ClipboardPasteResult,
  Disposable,
  TerminalAddon,
} from '@gespenst/core';

/** Stable categories reported by {@link ClipboardAddonError}. */
export type ClipboardAddonErrorCode =
  | 'disposed'
  | 'permission-denied'
  | 'read-failed'
  | 'too-large'
  | 'unsupported';

/** A normalized clipboard failure suitable for application error handling. */
export class ClipboardAddonError extends Error {
  /** Machine-readable error category. */
  readonly code: ClipboardAddonErrorCode;
  /** Browser or terminal error that caused this failure. */
  override readonly cause: unknown;

  constructor(code: ClipboardAddonErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ClipboardAddonError';
    this.code = code;
    this.cause = cause;
  }
}

/** Text requiring explicit confirmation before fallback paste can send it to a shell. */
export interface UnsafeClipboardPaste {
  /** Decoded clipboard text shown to the user for review. */
  readonly text: string;
  /** MIME representation selected for fallback text paste. */
  readonly mime: string;
  /** UTF-8 byte length of the selected representation. */
  readonly byteLength: number;
  /** Browser clipboard location that supplied the text. */
  readonly location: ClipboardLocation;
}

/** Security and resource policy for {@link ClipboardAddon}. */
export interface ClipboardAddonOptions {
  /** Maximum total clipboard bytes accepted per paste. @defaultValue `33554432` */
  readonly maxBytes?: number;
  /** Lifetime of a MIME snapshot awaiting a Kitty read request. @defaultValue `30000` */
  readonly snapshotTtlMs?: number;
  /** Clipboard location advertised to terminal applications. @defaultValue `'standard'` */
  readonly location?: ClipboardLocation;
  /**
   * Confirms text that could execute shell commands when bracketed paste is unavailable.
   *
   * @remarks Without this hook unsafe text is rejected. The callback should render a clear preview
   * and require an explicit user decision.
   */
  readonly confirmUnsafePaste?: (request: UnsafeClipboardPaste) => boolean | Promise<boolean>;
  /** Receives asynchronous failures from intercepted native paste events. */
  readonly onError?: (error: ClipboardAddonError) => void;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_SNAPSHOT_TTL_MS = 30_000;

/** Adds user-initiated MIME clipboard paste and Kitty clipboard protocol support. */
export class ClipboardAddon implements TerminalAddon {
  /** Settles when Ghostty clipboard callbacks have been installed. */
  readonly ready: Promise<void>;
  private readonly maxBytes: number;
  private readonly snapshotTtlMs: number;
  private readonly location: ClipboardLocation;
  private readonly confirmUnsafePaste: ClipboardAddonOptions['confirmUnsafePaste'];
  private readonly onError: ClipboardAddonOptions['onError'];
  private readonly resolveReady: () => void;
  private readonly rejectReady: (error: ClipboardAddonError) => void;
  private terminal: BrowserTerminal | null = null;
  private registration: Disposable | null = null;
  private disposed = false;
  private readySettled = false;

  constructor(options: ClipboardAddonOptions = {}) {
    this.maxBytes = integerOption('maxBytes', options.maxBytes ?? DEFAULT_MAX_BYTES, 1);
    this.snapshotTtlMs = integerOption(
      'snapshotTtlMs',
      options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
      1
    );
    this.location = options.location ?? 'standard';
    this.confirmUnsafePaste = options.confirmUnsafePaste;
    this.onError = options.onError;
    let resolveReady!: () => void;
    let rejectReady!: (error: ClipboardAddonError) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.resolveReady = resolveReady;
    this.rejectReady = rejectReady;
    void this.ready.catch(() => undefined);
  }

  /** Attaches native paste handling and enables Ghostty's clipboard protocol. */
  activate(terminal: BrowserTerminal): void {
    if (this.terminal) throw new Error('ClipboardAddon is already active');
    if (this.disposed) throw new Error('ClipboardAddon is disposed');
    this.terminal = terminal;
    terminal.element.addEventListener('paste', this.handlePaste, true);
    void terminal
      .enableClipboard({ maxBytes: this.maxBytes, snapshotTtlMs: this.snapshotTtlMs })
      .then((registration) => {
        if (this.disposed) {
          registration.dispose();
          return;
        }
        this.registration = registration;
        this.settleReady();
      })
      .catch((cause: unknown) => {
        const error = normalizeError(cause, 'read-failed', 'Clipboard protocol startup failed');
        this.failReady(error);
        this.report(error);
      });
  }

  /**
   * Reads the system clipboard and pastes it into the terminal.
   *
   * @remarks Call directly from a trusted click or keyboard handler. Browsers commonly reject
   * clipboard reads after the user-activation task has ended.
   */
  async pasteFromClipboard(): Promise<ClipboardPasteResult> {
    this.assertActive();
    const terminal = this.terminal;
    await this.ready;
    if (!terminal || this.disposed) throw disposedError();
    const contents = await readBrowserClipboard(this.maxBytes);
    return this.deliver(terminal, contents, this.location);
  }

  /** Releases DOM listeners, snapshots, and Ghostty clipboard callbacks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal?.element.removeEventListener('paste', this.handlePaste, true);
    this.registration?.dispose();
    this.registration = null;
    this.terminal = null;
    if (!this.readySettled) this.failReady(disposedError());
  }

  private readonly handlePaste = (event: Event): void => {
    const clipboardData = (event as ClipboardEvent).clipboardData;
    if (!clipboardData) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void this.pasteFromDataTransfer(clipboardData).catch((cause: unknown) =>
      this.report(normalizeError(cause, 'read-failed', 'Clipboard paste failed'))
    );
  };

  private async pasteFromDataTransfer(data: DataTransfer): Promise<ClipboardPasteResult> {
    this.assertActive();
    const terminal = this.terminal;
    await this.ready;
    if (!terminal || this.disposed) throw disposedError();
    const contents = await readDataTransfer(data, this.maxBytes);
    return this.deliver(terminal, contents, this.location);
  }

  private async deliver(
    terminal: BrowserTerminal,
    contents: readonly ClipboardContent[],
    location: ClipboardLocation
  ): Promise<ClipboardPasteResult> {
    let result = await terminal.pasteClipboard({ contents, location });
    if (result.status !== 'unsafe' || !this.confirmUnsafePaste) return result;
    const text = contents.find((content) => content.mime.startsWith('text/'));
    if (!text) return result;
    const confirmed = await this.confirmUnsafePaste({
      text: new TextDecoder().decode(text.data),
      mime: text.mime,
      byteLength: text.data.byteLength,
      location,
    });
    if (!confirmed) return result;
    result = await terminal.pasteClipboard({ contents, location, allowUnsafe: true });
    return result;
  }

  private assertActive(): void {
    if (this.disposed) throw disposedError();
    if (!this.terminal) throw new Error('ClipboardAddon must be loaded before use');
  }

  private settleReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private failReady(error: ClipboardAddonError): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady(error);
  }

  private report(error: ClipboardAddonError): void {
    try {
      this.onError?.(error);
    } catch {
      // Error observers must not create an unhandled rejection in native paste handling.
    }
  }
}

async function readBrowserClipboard(maxBytes: number): Promise<readonly ClipboardContent[]> {
  if (typeof navigator === 'undefined' || !navigator.clipboard)
    throw new ClipboardAddonError('unsupported', 'The browser Clipboard API is unavailable');
  const clipboard = navigator.clipboard as Clipboard & {
    read?: () => Promise<readonly ClipboardItem[]>;
  };
  try {
    if (typeof clipboard.read === 'function') {
      const items = await clipboard.read.call(clipboard);
      const blobs: Array<{ readonly mime: string; readonly blob: Blob }> = [];
      const seen = new Set<string>();
      let declaredBytes = 0;
      for (const item of items) {
        for (const mime of item.types) {
          const normalizedMime = mime.trim().toLowerCase();
          if (!normalizedMime || seen.has(normalizedMime)) continue;
          seen.add(normalizedMime);
          const blob = await item.getType(mime);
          declaredBytes += blob.size;
          assertSize(declaredBytes, maxBytes);
          blobs.push({ mime: normalizedMime, blob });
        }
      }
      return normalizeContents(await readBlobs(blobs, maxBytes), maxBytes);
    }
    if (typeof clipboard.readText !== 'function')
      throw new ClipboardAddonError('unsupported', 'The browser cannot read clipboard data');
    return normalizeContents(
      [{ mime: 'text/plain', data: new TextEncoder().encode(await clipboard.readText()) }],
      maxBytes
    );
  } catch (cause) {
    throw normalizeClipboardReadError(cause);
  }
}

async function readDataTransfer(
  transfer: DataTransfer,
  maxBytes: number
): Promise<readonly ClipboardContent[]> {
  const contents: ClipboardContent[] = [];
  const blobs: Array<{ readonly mime: string; readonly blob: Blob }> = [];
  const stringReads: Promise<void>[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind === 'file') {
      const blob = item.getAsFile();
      if (blob) blobs.push({ mime: item.type || blob.type || 'application/octet-stream', blob });
    } else if (item.kind === 'string') {
      stringReads.push(
        new Promise<void>((resolve) => {
          item.getAsString((value) => {
            contents.push({
              mime: item.type || 'text/plain',
              data: new TextEncoder().encode(value),
            });
            resolve();
          });
        })
      );
    }
  }
  if (transfer.items.length === 0) {
    for (const mime of transfer.types) {
      contents.push({
        mime: mime || 'text/plain',
        data: new TextEncoder().encode(transfer.getData(mime)),
      });
    }
  }
  await Promise.all(stringReads);
  const blobContents = await readBlobs(blobs, maxBytes);
  return normalizeContents([...contents, ...blobContents], maxBytes);
}

async function readBlobs(
  entries: readonly { readonly mime: string; readonly blob: Blob }[],
  maxBytes: number
): Promise<readonly ClipboardContent[]> {
  let declaredBytes = 0;
  for (const { blob } of entries) declaredBytes += blob.size;
  assertSize(declaredBytes, maxBytes);
  return Promise.all(
    entries.map(async ({ mime, blob }) => ({
      mime: mime || blob.type || 'application/octet-stream',
      data: new Uint8Array(await blob.arrayBuffer()),
    }))
  );
}

function normalizeContents(
  contents: readonly ClipboardContent[],
  maxBytes: number
): readonly ClipboardContent[] {
  const unique = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const content of contents) {
    const mime = content.mime.trim().toLowerCase();
    if (!mime || unique.has(mime)) continue;
    totalBytes += content.data.byteLength;
    assertSize(totalBytes, maxBytes);
    unique.set(mime, content.data);
  }
  return [...unique].map(([mime, data]) => ({ mime, data }));
}

function assertSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes)
    throw new ClipboardAddonError(
      'too-large',
      `Clipboard data exceeds the configured ${maxBytes}-byte limit`
    );
}

function integerOption(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  return value;
}

function normalizeClipboardReadError(cause: unknown): ClipboardAddonError {
  if (cause instanceof ClipboardAddonError) return cause;
  if (
    cause instanceof DOMException &&
    (cause.name === 'NotAllowedError' || cause.name === 'SecurityError')
  )
    return new ClipboardAddonError(
      'permission-denied',
      'Clipboard permission was denied or no user activation was available',
      cause
    );
  return new ClipboardAddonError('read-failed', 'The browser clipboard could not be read', cause);
}

function normalizeError(
  cause: unknown,
  code: ClipboardAddonErrorCode,
  message: string
): ClipboardAddonError {
  return cause instanceof ClipboardAddonError
    ? cause
    : new ClipboardAddonError(code, message, cause);
}

function disposedError(): ClipboardAddonError {
  return new ClipboardAddonError('disposed', 'ClipboardAddon is disposed');
}

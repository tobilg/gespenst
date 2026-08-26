import {
  type CoreTerminal,
  createCoreRuntime,
  type Disposable,
  KeyModifiers,
  type RenderCursor,
  type RenderRow,
} from '@gespenst/core/headless';

// #region headless
const runtime = await createCoreRuntime();
const terminal = runtime.createTerminal({ cols: 100, rows: 30, scrollbackLines: 2_000 });

terminal.write('\x1b[1;34mParsed by Ghostty VT\x1b[0m\r\n');
const frame = terminal.viewport();
const text = frame.viewportRows.map((row) => row.text).join('\n');

terminal.key({
  code: 'KeyC',
  text: 'c',
  modifiers: KeyModifiers.control,
});

console.log(text);
runtime.dispose();
// #endregion headless

// #region headless-test
export async function assertCliOutput(): Promise<void> {
  const runtime = await createCoreRuntime();
  try {
    const terminal = runtime.createTerminal({ cols: 80, rows: 24 });
    terminal.write('\x1b[32mBuild succeeded\x1b[0m\r\n');

    const screen = terminal
      .viewport()
      .viewportRows.map((row) => row.text)
      .join('\n');

    if (!screen.includes('Build succeeded')) {
      throw new Error('Expected the success message in the visible terminal');
    }
  } finally {
    runtime.dispose();
  }
}
// #endregion headless-test

// #region headless-pty
interface PtyAdapter {
  onData(listener: (data: string) => void): Disposable;
  write(data: string): void;
}

export async function attachPty(
  pty: PtyAdapter,
  sendToClient: (message: unknown) => void
): Promise<Disposable> {
  const runtime = await createCoreRuntime();
  const terminal = runtime.createTerminal({ cols: 120, rows: 30 });
  const decoder = new TextDecoder();

  const output = pty.onData((data) => {
    terminal.write(data);
    const frame = terminal.render();

    if (frame.dirty !== 'clean') {
      sendToClient({ rows: frame.changedRows, cursor: frame.cursor });
    }
  });

  const input = terminal.on('input', ({ data }) => {
    pty.write(decoder.decode(data, { stream: true }));
  });

  return {
    dispose() {
      output.dispose();
      input.dispose();
      runtime.dispose();
    },
  };
}
// #endregion headless-pty

// #region headless-renderer
interface IncrementalRenderer {
  updateRow(row: RenderRow): void;
  updateCursor(cursor: RenderCursor): void;
  present(): void;
}

export function renderOutput(
  terminal: CoreTerminal,
  renderer: IncrementalRenderer,
  data: string | Uint8Array
): void {
  terminal.write(data);
  const frame = terminal.render();

  for (const row of frame.changedRows) renderer.updateRow(row);
  renderer.updateCursor(frame.cursor);
  renderer.present();
}
// #endregion headless-renderer

// #region headless-index
interface TextIndex {
  add(text: string): Promise<void>;
}

export async function indexTerminalBuffer(terminal: CoreTerminal, index: TextIndex): Promise<void> {
  terminal.selectAll();
  try {
    const transcript = terminal.getSelection({
      format: 'plain',
      unwrap: true,
      trim: true,
    });
    await index.add(transcript);
  } finally {
    terminal.clearSelection();
  }
}
// #endregion headless-index

// #region headless-replay
interface RecordingEntry {
  readonly delayMs: number;
  readonly data: string | Uint8Array;
}

export async function replay(
  terminal: CoreTerminal,
  renderer: IncrementalRenderer,
  recording: readonly RecordingEntry[]
): Promise<void> {
  for (const entry of recording) {
    await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
    renderOutput(terminal, renderer, entry.data);
  }
}
// #endregion headless-replay

// #region headless-snapshot
interface SnapshotStorage {
  save(id: string, snapshot: Uint8Array): Promise<void>;
  load(id: string): Promise<Uint8Array>;
}

export async function checkpointTerminal(
  terminal: CoreTerminal,
  storage: SnapshotStorage
): Promise<void> {
  await storage.save('session-123', terminal.snapshot());
}

export async function restoreTerminal(
  storage: SnapshotStorage
): Promise<{ readonly terminal: CoreTerminal; dispose(): void }> {
  const runtime = await createCoreRuntime();
  const terminal = runtime.createTerminal();
  terminal.restore(await storage.load('session-123'));
  return {
    terminal,
    dispose() {
      runtime.dispose();
    },
  };
}
// #endregion headless-snapshot

// #region headless-input
export function connectInput(
  terminal: CoreTerminal,
  sendToPty: (data: Uint8Array) => void
): Disposable {
  const input = terminal.on('input', ({ data }) => sendToPty(data));

  terminal.key({ code: 'ArrowUp' });
  terminal.paste('hello\nworld');
  terminal.focus(true);

  return input;
}
// #endregion headless-input

// #region headless-events
interface SessionMetadata {
  title: string;
  cwd: string;
  progress: number | null;
}

export function observeSession(
  terminal: CoreTerminal,
  metadata: SessionMetadata,
  notify: (title: string, body: string) => void
): Disposable {
  const subscriptions = [
    terminal.on('title', (title) => {
      metadata.title = title;
    }),
    terminal.on('cwd', (cwd) => {
      metadata.cwd = cwd;
    }),
    terminal.on('progress', ({ progress }) => {
      metadata.progress = progress;
    }),
    terminal.on('notification', ({ title, body }) => notify(title, body)),
  ];

  return {
    dispose() {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
// #endregion headless-events

// #region headless-multiple
export async function createSessionPool(): Promise<Disposable> {
  const runtime = await createCoreRuntime();
  const sessions = new Map([
    ['build', runtime.createTerminal()],
    ['server', runtime.createTerminal()],
    ['tests', runtime.createTerminal()],
  ]);

  sessions.get('build')?.write('Compiling...\r\n');
  sessions.get('tests')?.write('14 tests passed\r\n');

  return runtime;
}
// #endregion headless-multiple

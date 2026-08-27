import { createCoreRuntime } from '@gespenst/core/headless';

const runtime = await createCoreRuntime();
const terminal = runtime.createTerminal({ cols: 32, rows: 4, scrollbackLines: 100 });
try {
  terminal.write('\x1b[32mpublished headless\x1b[0m 界🙂\r\n');
  for (let index = 0; index < 12; index += 1) terminal.write(`row ${index}\r\n`);
  const viewport = terminal.viewport();
  const state = terminal.bufferState();
  const buffer = terminal.readBuffer({ start: 0, end: state.totalRows });
  if (!buffer.rows.some((row) => row.text.includes('published headless'))) {
    throw new Error('Headless retained buffer omitted published output');
  }
  if (!viewport.viewportRows.some((row) => row.text.includes('row 11'))) {
    throw new Error('Headless viewport omitted final output');
  }
  const snapshot = terminal.snapshot();
  terminal.write('after snapshot');
  terminal.restore(snapshot);
  const restoredState = terminal.bufferState();
  const restored = terminal.readBuffer({ start: 0, end: restoredState.totalRows });
  if (restored.rows.some((row) => row.text.includes('after snapshot'))) {
    throw new Error('Headless snapshot restore retained later output');
  }
  process.stdout.write(
    `${JSON.stringify({ scenario: 'headless', rows: buffer.rows.length, snapshotBytes: snapshot.byteLength })}\n`
  );
} finally {
  terminal.dispose();
  runtime.dispose();
}

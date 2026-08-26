import { afterAll, beforeAll, bench, describe } from 'vitest';
import { type CoreRuntime, type CoreTerminal, createCoreRuntime } from '../src/core';

let runtime: CoreRuntime;
let terminal: CoreTerminal;
const payload = new TextEncoder().encode(
  Array.from(
    { length: 2_000 },
    (_, index) => `\u001b[3${index % 8}mrow ${index}: ${'x'.repeat(64)}\u001b[0m\r\n`
  ).join('')
);

beforeAll(async () => {
  runtime = await createCoreRuntime();
  terminal = runtime.createTerminal({ cols: 120, rows: 40, scrollbackLines: 0 });
});

afterAll(() => runtime.dispose());

describe('Ghostty nightly', () => {
  bench('parse VT byte stream', () => {
    terminal.write(payload);
  });

  bench('read render snapshot', () => {
    terminal.viewport();
  });
});

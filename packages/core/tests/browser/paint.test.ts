import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { Terminal } from '../../../xterm/src';
import { createTerminal } from '../../src';

// These tests check that buffer changes reach the screen through every write path. The cursor
// row is always repainted, so the edit happens on another row while the cursor stays put.

const disposables: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose();
  document.body.replaceChildren();
});

function host(): HTMLDivElement {
  const element = document.createElement('div');
  element.style.width = '320px';
  element.style.height = '100px';
  document.body.append(element);
  return element;
}

/** Captures the pixels of the first terminal row, which is where the edit lands. */
async function firstRow(element: Element, rows: number): Promise<string> {
  const image = new Image();
  image.src = `data:image/png;base64,${await page.screenshot({ element, save: false })}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = Math.floor(image.height / rows);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  context.drawImage(image, 0, 0);
  return canvas.toDataURL();
}

/** Waits until two consecutive captures agree, so the previous write is fully on screen. */
async function settledFirstRow(element: Element, rows: number): Promise<string> {
  let previous = await firstRow(element, rows);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await firstRow(element, rows);
    if (current === previous) return current;
    previous = current;
  }
  throw new Error('The terminal never finished painting');
}

const rows = 4;
const initial = 'line1\r\nline2';
// Save the cursor, overwrite the first row, and restore the cursor to the second row.
const edit = '\x1b7\x1b[1;1HXXXXXXXX\x1b8';

describe.each([
  ['worker', true],
  ['main thread', false],
] as const)('painted output (%s)', (_name, worker) => {
  it('repaints native writes away from the cursor', async () => {
    const terminal = await createTerminal({
      container: host(),
      worker,
      renderer: 'canvas2d',
      cols: 20,
      rows,
    });
    disposables.push(terminal);

    await terminal.writeAsync(initial);
    const before = await settledFirstRow(terminal.element, rows);
    await terminal.writeAsync(edit);
    await expect.poll(() => firstRow(terminal.element, rows)).not.toBe(before);
  });
});

describe('painted xterm output', () => {
  it('repaints xterm adapter writes away from the cursor', async () => {
    const terminal = new Terminal({
      cols: 20,
      rows,
      gespenst: { renderer: 'canvas2d' },
    });
    disposables.push(terminal);
    terminal.open(host());
    await terminal.ready;
    const element = terminal.element as HTMLElement;
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

    await write(initial);
    const before = await settledFirstRow(element, rows);
    await write(edit);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('XXXXXXXX');
    await expect.poll(() => firstRow(element, rows)).not.toBe(before);
  });
});

import { createTerminal } from '../packages/core/src/index.ts';

const container = document.querySelector<HTMLElement>('#terminal');
if (!container) throw new Error('Missing terminal container');

const terminal = await createTerminal({
  container,
  fontSizePx: 15,
  accessibility: 'full',
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let output!: ReadableStreamDefaultController<Uint8Array>;
let command = '';

const readable = new ReadableStream<Uint8Array>({
  start(controller) {
    output = controller;
    controller.enqueue(
      encoder.encode(
        '\x1b[1;35mgespenst\x1b[0m — Ghostty VT for TypeScript\r\n' +
          'Try colors, Unicode, selection, resize, copy/paste, and the worker renderer.\r\n\r\n' +
          '\x1b[1;32m$\x1b[0m '
      )
    );
  },
});

const writable = new WritableStream<Uint8Array>({
  write(bytes) {
    const text = decoder.decode(bytes, { stream: true });
    if (text === '\r') {
      output.enqueue(
        encoder.encode(`\r\ncommand: \x1b[36m${command || '(empty)'}\x1b[0m\r\n\x1b[1;32m$\x1b[0m `)
      );
      command = '';
    } else if (text === '\u007f' || text === '\b') {
      if (command) {
        command = command.slice(0, -1);
        output.enqueue(encoder.encode('\b \b'));
      }
    } else if (!text.startsWith('\x1b')) {
      command += text;
      output.enqueue(bytes);
    }
  },
});

terminal.connect({ readable, writable });
terminal.focus();

import { createTerminal } from '@gespenst/core';
import { describe, expect, it, vi } from 'vitest';
import { createBashKitShell } from '../../src';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('@gespenst/bashkit browser integration', () => {
  it('runs stateful filesystem commands through the real BashKit runtime', async () => {
    const session = await createBashKitShell({
      bash: {
        cwd: '/home/guest',
        files: {
          '/home/guest/README.md': 'BashKit browser fixture\n',
          '/home/guest/hello.txt': 'Hello\n',
        },
      },
    });
    const reader = session.transport.readable.getReader();
    const writer = session.transport.writable.getWriter();

    expect(decoder.decode((await reader.read()).value)).toBe('bash $ ');
    await writer.write(encoder.encode('pwd\r'));
    expect(await readThroughPrompt(reader)).toContain('/home/guest\r\n');
    await writer.write(encoder.encode('cd / && pwd\r'));
    expect(await readThroughPrompt(reader)).toContain('/\r\n');
    await writer.write(encoder.encode('cd /home/guest && ls -la\r'));
    const listing = await readThroughPrompt(reader);
    expect(listing).toContain('README.md');
    expect(listing).toContain('hello.txt');
    await writer.write(encoder.encode('definitely-missing-command\r'));
    const failure = await readThroughPrompt(reader);
    expect(failure).toContain('command not found\r\n\x1b[0mbash $ ');
    expect(failure).not.toContain('command not found\x1b[0mbash $ ');

    session.dispose();
    await expect(session.exit).resolves.toEqual({ code: 0, reason: 'disposed' });
  }, 15_000);

  it('runs commands through core using the mobile textarea input path', async () => {
    const container = document.createElement('div');
    container.style.width = '640px';
    container.style.height = '240px';
    document.body.append(container);
    const terminal = await createTerminal({
      container,
      cols: 80,
      rows: 12,
      worker: false,
      renderer: 'auto',
    });
    const session = await createBashKitShell({
      bash: {
        cwd: '/home/guest',
        files: { '/home/guest/README.md': 'mobile input fixture\n' },
      },
    });
    const connection = terminal.connect(session.transport);
    const textarea = terminal.element.querySelector('textarea');
    if (!textarea) throw new Error('Expected terminal textarea');

    try {
      await vi.waitFor(async () => expect(await bufferText(terminal)).toContain('bash $ '));
      submitMobileInput(textarea, 'pwd');
      await vi.waitFor(async () => expect(await bufferText(terminal)).toContain('/home/guest'));
      submitMobileInput(textarea, 'ls -la');
      await vi.waitFor(async () => expect(await bufferText(terminal)).toContain('README.md'));
    } finally {
      connection.dispose();
      session.dispose();
      terminal.dispose();
      container.remove();
    }
  }, 15_000);
});

async function readThroughPrompt(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let output = '';
  while (!output.endsWith('bash $ ')) {
    const next = await reader.read();
    if (next.done) throw new Error('BashKit shell closed before its next prompt');
    output += decoder.decode(next.value, { stream: true });
  }
  return output;
}

function submitMobileInput(textarea: HTMLTextAreaElement, command: string): void {
  textarea.value = command;
  textarea.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command })
  );
  textarea.value = '\n';
  textarea.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: null })
  );
}

async function bufferText(terminal: Awaited<ReturnType<typeof createTerminal>>): Promise<string> {
  return (await terminal.readBuffer()).rows.map((row) => row.text).join('\n');
}

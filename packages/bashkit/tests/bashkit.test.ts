import type { Bash } from '@everruns/bashkit-wasm';
import { describe, expect, it, vi } from 'vitest';
import { type BashKitCommandExecutor, createManagedBashKitSession } from '../src/session';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('@gespenst/bashkit session', () => {
  it('provides Unicode-safe editing, command output, queued input, and history', async () => {
    const execute = vi.fn(
      async (command: string, onOutput: (stdout: string, stderr: string) => void) => {
        onOutput(`${command}: stdout\n`, '');
        return { stderr: '', exitCode: 0 };
      }
    );
    const session = createSession({ execute, cancel: vi.fn(), clearCancel: vi.fn() });
    const reader = session.transport.readable.getReader();
    const writer = session.transport.writable.getWriter();

    expect(decoder.decode((await reader.read()).value)).toBe('bash $ ');
    await writer.write(encoder.encode(`a界🙂\x7fc\rnext\r`));
    const first = await readThroughPrompt(reader);
    expect(execute).toHaveBeenNthCalledWith(1, 'a界c', expect.any(Function));
    expect(first).toContain('a界🙂\b \bc\r\na界c: stdout\r\nbash $ ');
    expect(await readThroughPrompt(reader)).toContain('next\r\nnext: stdout\r\nbash $ ');

    await writer.write(encoder.encode('\x1b[A\r'));
    expect(await readThroughPrompt(reader)).toContain('\r\x1b[2Kbash $ next');

    session.dispose();
  });

  it('cancels an active command, clears sticky cancellation, and processes typeahead', async () => {
    let finish!: () => void;
    const first = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn();
    const clearCancel = vi.fn();
    const execute = vi.fn(async (command: string) => {
      if (command === 'slow') await first;
      return { stderr: '', exitCode: 0 };
    });
    const session = createSession({ execute, cancel, clearCancel });
    const reader = session.transport.readable.getReader();
    const writer = session.transport.writable.getWriter();
    await reader.read();

    await writer.write(encoder.encode('slow\r\x03next\r'));
    expect(cancel).toHaveBeenCalledTimes(1);
    finish();
    await readThroughPrompt(reader);
    await readThroughPrompt(reader);

    expect(clearCancel).toHaveBeenCalled();
    expect(execute).toHaveBeenNthCalledWith(2, 'next', expect.any(Function));
    session.dispose();
  });

  it('settles exit and disposal without leaving transport reads pending', async () => {
    const session = createSession({
      execute: vi.fn(async () => ({ stderr: '', exitCode: 0 })),
      cancel: vi.fn(),
      clearCancel: vi.fn(),
    });
    const reader = session.transport.readable.getReader();
    const writer = session.transport.writable.getWriter();
    await reader.read();

    await writer.write(encoder.encode('exit 7\r'));

    await expect(session.exit).resolves.toEqual({ code: 7, reason: 'exit' });
    expect(session.status).toBe('exited');
    let done = false;
    while (!done) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('fails a command stream that exceeds its bounded output queue', async () => {
    const session = createSession(
      {
        execute: vi.fn(async (_command, onOutput) => {
          onOutput('output larger than limit', '');
          return { stderr: '', exitCode: 0 };
        }),
        cancel: vi.fn(),
        clearCancel: vi.fn(),
      },
      8
    );
    const reader = session.transport.readable.getReader();
    const writer = session.transport.writable.getWriter();
    await reader.read();

    await writer.write(encoder.encode('x\r'));

    await expect(session.exit).rejects.toThrow('8-byte buffer limit');
    await expect(reader.read()).rejects.toThrow('8-byte buffer limit');
    expect(session.status).toBe('error');
  });

  it('supports line controls, bounded history, stderr, and command failures', async () => {
    const execute = vi.fn(
      async (command: string, onOutput: (stdout: string, stderr: string) => void) => {
        if (command === 'stderr') {
          onOutput('', 'diagnostic\n');
          return { stderr: 'diagnostic', exitCode: 2 };
        }
        if (command === 'stderr-no-linefeed') {
          onOutput('', 'bash: graphql: command not found');
          return { stderr: 'bash: graphql: command not found', exitCode: 127 };
        }
        if (command === 'throw') throw 'plain failure';
        return { stderr: '', exitCode: command === 'nonzero' ? 3 : 0 };
      }
    );
    const session = createSession(
      { execute, cancel: vi.fn(), clearCancel: vi.fn() },
      1024 * 1024,
      1
    );
    const reader = session.transport.readable.getReader();
    const writer = session.transport.writable.getWriter();
    await reader.read();

    await writer.write(encoder.encode('draft\x15'));
    expect(await readThroughPrompt(reader)).toContain('\r\x1b[2Kbash $ ');
    await writer.write(encoder.encode('kept\x0c\r'));
    expect(await readThroughPrompt(reader)).toContain('\x1b[2J\x1b[Hbash $ kept');
    await writer.write(encoder.encode('stderr\r'));
    expect(await readThroughPrompt(reader)).toContain('\x1b[31mdiagnostic\r\n\x1b[0m');
    await writer.write(encoder.encode('stderr-no-linefeed\r'));
    expect(await readThroughPrompt(reader)).toContain(
      '\x1b[31mbash: graphql: command not found\r\n\x1b[0mbash $ '
    );
    await writer.write(encoder.encode('nonzero\r'));
    expect(await readThroughPrompt(reader)).toContain('exit code: 3');
    await writer.write(encoder.encode('throw\r'));
    expect(await readThroughPrompt(reader)).toContain('plain failure');

    await writer.write(encoder.encode('\x1b[A\x1b[B\r'));
    expect(await readThroughPrompt(reader)).toContain('\r\x1b[2Kbash $ throw');
    session.dispose();
  });

  it('reports status, closes active commands, and rejects writes after closure', async () => {
    let finish!: () => void;
    const command = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn();
    const session = createSession({
      execute: vi.fn(async () => {
        await command;
        return { stderr: '', exitCode: 0 };
      }),
      cancel,
      clearCancel: vi.fn(),
    });
    const statuses: string[] = [];
    const subscription = session.onStatusChange((status) => statuses.push(status));
    const reader = session.transport.readable.getReader();
    const writer = session.transport.writable.getWriter();
    await reader.read();
    await writer.write(encoder.encode('slow\r'));

    const closing = session.close();
    expect(session.status).toBe('closing');
    expect(cancel).toHaveBeenCalled();
    finish();

    await expect(closing).resolves.toEqual({ code: 0, reason: 'closed' });
    expect(statuses).toEqual(['closing', 'exited']);
    await expect(writer.write(encoder.encode('late'))).rejects.toThrow('not running');
    await expect(session.close()).resolves.toEqual({ code: 0, reason: 'closed' });
    subscription.dispose();
    session.dispose();
    session.dispose();
  });

  it('settles disposal through readable cancellation, writable abort, and close guards', async () => {
    const cancelled = createSession({
      execute: vi.fn(async () => ({ stderr: '', exitCode: 0 })),
      cancel: vi.fn(),
      clearCancel: vi.fn(),
    });
    await cancelled.transport.readable.cancel();
    await expect(cancelled.exit).resolves.toEqual({ code: 0, reason: 'disposed' });
    await expect(cancelled.close()).rejects.toThrow('disposed');

    const aborted = createSession({
      execute: vi.fn(async () => ({ stderr: '', exitCode: 0 })),
      cancel: vi.fn(),
      clearCancel: vi.fn(),
    });
    await aborted.transport.writable.abort();
    await expect(aborted.exit).resolves.toEqual({ code: 0, reason: 'disposed' });
  });
});

function createSession(
  executor: BashKitCommandExecutor,
  maxBufferedOutputBytes = 1024 * 1024,
  historyLimit = 100
) {
  return createManagedBashKitSession({
    bash: {} as Bash,
    executor,
    prompt: 'bash $ ',
    historyLimit,
    maxBufferedOutputBytes,
  });
}

async function readThroughPrompt(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let output = '';
  while (!output.endsWith('bash $ ')) {
    const next = await reader.read();
    if (next.done) throw new Error('BashKit shell closed before its next prompt');
    output += decoder.decode(next.value, { stream: true });
  }
  return output;
}

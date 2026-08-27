import type { BrowserTerminal, TerminalConnection } from '@gespenst/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BashKitAddon } from '../src/addon';

const mocks = vi.hoisted(() => ({
  createShell: vi.fn(),
}));

vi.mock('../src/runtime', () => ({
  createBashKitShell: mocks.createShell,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BashKitAddon', () => {
  it('starts a shell and connects its transport to the terminal', async () => {
    const session = fakeSession();
    const terminal = fakeTerminal();
    const addon = new BashKitAddon({
      prompt: 'guest $ ',
      connection: { highWaterMarkBytes: 4096 },
    });
    mocks.createShell.mockResolvedValue(session);

    addon.activate(terminal.value);

    await expect(addon.ready).resolves.toEqual({ session, connection: terminal.connection });
    expect(mocks.createShell).toHaveBeenCalledWith({
      prompt: 'guest $ ',
      connection: { highWaterMarkBytes: 4096 },
    });
    expect(terminal.connect).toHaveBeenCalledWith(session.transport, {
      highWaterMarkBytes: 4096,
    });

    expect(() => addon.activate(terminal.value)).toThrow('already active');
    addon.dispose();
    addon.dispose();
    expect(terminal.connection.dispose).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('rejects startup failures and converts non-Error failures', async () => {
    mocks.createShell.mockRejectedValue('runtime failed');
    const addon = new BashKitAddon();

    addon.activate(fakeTerminal().value);

    await expect(addon.ready).rejects.toThrow('runtime failed');
  });

  it('rejects pending startup and disposes a shell that resolves after disposal', async () => {
    let resolveShell!: (session: ReturnType<typeof fakeSession>) => void;
    mocks.createShell.mockReturnValue(
      new Promise((resolve) => {
        resolveShell = resolve;
      })
    );
    const session = fakeSession();
    const addon = new BashKitAddon();
    addon.activate(fakeTerminal().value);

    addon.dispose();
    resolveShell(session);

    await expect(addon.ready).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
    expect(() => addon.activate(fakeTerminal().value)).toThrow('disposed');
  });
});

function fakeSession() {
  return {
    transport: {
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
    },
    dispose: vi.fn(),
  };
}

function fakeTerminal() {
  const connection = {
    status: 'open',
    dispose: vi.fn(),
  } as unknown as TerminalConnection;
  const connect = vi.fn(() => connection);
  const value = { connect } as unknown as BrowserTerminal;
  return { value, connect, connection };
}

import type { BrowserTerminal, TerminalConnection } from '@gespenst/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserShellAddon } from '../src';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  construct: vi.fn(),
  dispose: vi.fn(),
  ready: vi.fn(),
}));

vi.mock('@gespenst/bashkit', () => ({
  BashKitAddon: class {
    readonly ready = mocks.ready();

    constructor(options: unknown) {
      mocks.construct(options);
    }

    activate = mocks.activate;
    dispose = mocks.dispose;
  },
}));

const connection = { status: 'open' } as TerminalConnection;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ready.mockReturnValue(Promise.resolve({ session: fakeSession(), connection }));
});

describe('@gespenst/shell', () => {
  it('starts BashKit and exposes the stable backend discriminator', async () => {
    const terminal = {} as BrowserTerminal;
    const events: string[] = [];
    const shell = new BrowserShellAddon();
    const subscription = shell.onStatusChange(({ status }) => events.push(status));

    shell.activate(terminal);
    const ready = await shell.ready;

    expect(ready).toMatchObject({ backend: 'bashkit', connection });
    expect(shell.backend).toBe('bashkit');
    expect(shell.status).toBe('ready');
    expect(mocks.construct).toHaveBeenCalledWith({});
    expect(mocks.activate).toHaveBeenCalledWith(terminal);
    expect(events).toEqual(['starting', 'ready']);
    subscription.dispose();
  });

  it('forwards BashKit and terminal connection options', async () => {
    const shell = new BrowserShellAddon({
      bashkit: { prompt: 'browser $ ', historyLimit: 25 },
      connection: { highWaterMarkBytes: 8192 },
    });

    shell.activate({} as BrowserTerminal);
    await shell.ready;

    expect(mocks.construct).toHaveBeenCalledWith({
      prompt: 'browser $ ',
      historyLimit: 25,
      connection: { highWaterMarkBytes: 8192 },
    });
  });

  it('reports startup failures and disposes the failed implementation', async () => {
    mocks.ready.mockReturnValue(Promise.reject(new Error('interpreter failed')));
    const shell = new BrowserShellAddon();

    shell.activate({} as BrowserTerminal);

    await expect(shell.ready).rejects.toThrow('interpreter failed');
    expect(shell.status).toBe('error');
    expect(shell.error?.message).toBe('interpreter failed');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('reports normal completion and runtime failures after readiness', async () => {
    let resolveExit!: () => void;
    const successfulExit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    mocks.ready.mockReturnValue(
      Promise.resolve({ session: fakeSession(successfulExit), connection })
    );
    const completed = new BrowserShellAddon();
    completed.activate({} as BrowserTerminal);
    await completed.ready;
    resolveExit();
    await vi.waitFor(() => expect(completed.status).toBe('exited'));

    let rejectExit!: (reason: unknown) => void;
    const failedExit = new Promise<void>((_resolve, reject) => {
      rejectExit = reject;
    });
    failedExit.catch(() => undefined);
    mocks.ready.mockReturnValue(Promise.resolve({ session: fakeSession(failedExit), connection }));
    const failed = new BrowserShellAddon();
    failed.activate({} as BrowserTerminal);
    await failed.ready;
    rejectExit('runtime stopped');
    await vi.waitFor(() => expect(failed.error?.message).toBe('runtime stopped'));
    expect(failed.status).toBe('error');
  });

  it('rejects pending startup and disposes a late implementation', async () => {
    let resolve!: (value: unknown) => void;
    mocks.ready.mockReturnValue(
      new Promise((ready) => {
        resolve = ready;
      })
    );
    const shell = new BrowserShellAddon();
    shell.activate({} as BrowserTerminal);
    await vi.waitFor(() => expect(mocks.activate).toHaveBeenCalled());

    shell.dispose();
    resolve({ session: fakeSession(), connection });

    await expect(shell.ready).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    expect(mocks.dispose).toHaveBeenCalled();
  });

  it('guards repeated activation and disposal', async () => {
    const terminal = {} as BrowserTerminal;
    const shell = new BrowserShellAddon();
    shell.activate(terminal);
    expect(() => shell.activate(terminal)).toThrow('already active');
    await shell.ready;

    shell.dispose();
    shell.dispose();

    expect(shell.status).toBe('disposed');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('rejects activation after disposal and emits disposal once', async () => {
    const events: string[] = [];
    const shell = new BrowserShellAddon();
    shell.onStatusChange(({ status }) => events.push(status));

    shell.dispose();
    shell.dispose();

    await expect(shell.ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['disposed']);
    expect(() => shell.activate({} as BrowserTerminal)).toThrow('disposed');
  });
});

function fakeSession(exit: Promise<unknown> = new Promise(() => {})) {
  return { exit, dispose: vi.fn() };
}

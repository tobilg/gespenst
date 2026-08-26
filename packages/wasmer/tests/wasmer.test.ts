import type { BrowserTerminal, TerminalConnection } from '@gespenst/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWasmerDirectory,
  createWasmerSession,
  createWasmerShell,
  getWasmerBrowserSupport,
  WasmerAddon,
  type WasmerProcessInstance,
  type WasmerProcessOutput,
  wasmerProcessTransport,
} from '../src';

const mocks = vi.hoisted(() => ({
  init: vi.fn(async () => undefined),
  fromFile: vi.fn(),
  fromRegistry: vi.fn(),
  fromWasm: vi.fn(),
  run: vi.fn(),
  packageFree: vi.fn(),
  runtimeFree: vi.fn(),
  directoryFree: vi.fn(),
}));

vi.mock('@wasmer/sdk', () => ({
  init: mocks.init,
  Runtime: class {
    free = mocks.runtimeFree;
  },
  Directory: class {
    private readonly files = new Map<string, string | Uint8Array>();
    constructor(initial: Record<string, string | Uint8Array> = {}) {
      for (const [path, value] of Object.entries(initial)) this.files.set(path, value);
    }
    free = mocks.directoryFree;
    async readDir() {
      return [...this.files.keys()].map((name) => ({ type: 'file' as const, name }));
    }
    async writeFile(path: string, contents: string | Uint8Array) {
      this.files.set(path, contents);
    }
    async readFile(path: string) {
      const value = this.files.get(path);
      if (value === undefined) throw new Error(`Missing ${path}`);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    }
    async readTextFile(path: string) {
      return new TextDecoder().decode(await this.readFile(path));
    }
    async createDir() {}
    async removeDir() {}
    async removeFile(path: string) {
      this.files.delete(path);
    }
  },
  Wasmer: {
    fromFile: mocks.fromFile,
    fromRegistry: mocks.fromRegistry,
    fromWasm: mocks.fromWasm,
  },
}));

const output: WasmerProcessOutput = {
  code: 0,
  ok: true,
  stdoutBytes: new Uint8Array(),
  stdout: '',
  stderrBytes: new Uint8Array(),
  stderr: '',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('@gespenst/wasmer', () => {
  it('reports missing browser isolation without importing Wasmer', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('crossOriginIsolated', false);
    vi.stubGlobal('Worker', undefined);

    const support = getWasmerBrowserSupport();

    expect(support.supported).toBe(false);
    expect(support.missing).toContain('secure-context');
    expect(support.missing).toContain('cross-origin-isolation');
    expect(support.missing).toContain('web-worker');
  });

  it('adapts Wasmer stdin, stdout, and stderr to byte streams', async () => {
    const input: Uint8Array[] = [];
    const instance = fakeInstance({
      stdin: new WritableStream({
        write(data) {
          input.push(data.slice());
        },
      }),
      stdout: stream('stdout'),
      stderr: stream(new Uint8Array([33])),
    });
    const transport = wasmerProcessTransport(instance);
    const writer = transport.writable.getWriter();
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();

    const chunks = await collect(transport.readable);

    expect(input).toEqual([new Uint8Array([1, 2, 3])]);
    expect(new TextDecoder().decode(concat(chunks))).toBe('stdout!');
  });

  it('applies PTY-style carriage returns to process output across chunk boundaries', async () => {
    const instance = fakeInstance({
      stdout: streamChunks(['first\nsecond\r', '\nthird\n', 'fourth\r']),
      stderr: stream(new Uint8Array()),
    });
    const transport = wasmerProcessTransport(instance);

    const chunks = await collect(transport.readable);

    expect(new TextDecoder().decode(concat(chunks))).toBe('first\r\nsecond\r\nthird\r\nfourth\r');
  });

  it('coalesces the chunks a process has ready into one read', async () => {
    const instance = fakeInstance({
      stdout: streamChunks(['alpha', 'beta', 'gamma', 'delta']),
      stderr: stream(new Uint8Array()),
    });
    const transport = wasmerProcessTransport(instance);

    const chunks = await collect(transport.readable);

    // Without draining, each ready chunk needed its own pull, which the consumer issues at
    // about one per frame.
    expect(chunks.length).toBe(1);
    expect(new TextDecoder().decode(concat(chunks))).toBe('alphabetagammadelta');
  });

  it('bounds a single drain so a flooding process cannot hold the pull loop', async () => {
    const endless = (byte: number) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([byte]));
        },
      });
    const transport = wasmerProcessTransport(
      fakeInstance({ stdout: endless(1), stderr: endless(2) })
    );

    const reader = transport.readable.getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeGreaterThan(1);
    expect(first.value?.byteLength).toBeLessThanOrEqual(4096);

    await reader.cancel('test complete');
  });

  it('stops pulling process output while the terminal consumer is paused', async () => {
    let pulls = 0;
    const endless = (byte: number) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([byte]));
        },
      });
    const transport = wasmerProcessTransport(
      fakeInstance({ stdout: endless(1), stderr: endless(2) })
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBeLessThanOrEqual(2);

    const reader = transport.readable.getReader();
    expect((await reader.read()).done).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    const pausedPulls = pulls;
    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBe(pausedPulls);

    await reader.cancel('test complete');
  });

  it('closes paused process output when the session is disposed', async () => {
    const endless = (byte: number) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([byte]));
        },
      });
    const session = createWasmerSession(
      fakeInstance({
        stdout: endless(1),
        stderr: endless(2),
        wait: new Promise<WasmerProcessOutput>(() => undefined),
      })
    );
    const reader = session.transport.readable.getReader();

    expect((await reader.read()).done).toBe(false);
    session.dispose();

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it('tracks graceful process exit and transitions to disposed', async () => {
    let finish!: (value: WasmerProcessOutput) => void;
    const wait = new Promise<WasmerProcessOutput>((resolve) => {
      finish = resolve;
    });
    const instance = fakeInstance({
      stdin: new WritableStream({ close: () => finish(output) }),
      wait,
    });
    const session = createWasmerSession(instance);
    const statuses: string[] = [];
    session.onStatusChange((status) => statuses.push(status));

    expect(await session.close()).toBe(output);
    expect(session.status).toBe('exited');
    expect(session.capabilities).toMatchObject({ interactiveInput: true, resize: false });
    expect(statuses).toEqual(['closing', 'exited']);

    session.dispose();
    expect(session.status).toBe('disposed');
  });

  it('does not access an SDK instance after wait consumes its handle', async () => {
    let consumed = false;
    const stdin = new WritableStream<Uint8Array>();
    const stdout = stream(new Uint8Array());
    const stderr = stream(new Uint8Array());
    const instance: WasmerProcessInstance = {
      get stdin() {
        if (consumed) throw new Error('consumed instance accessed');
        return stdin;
      },
      get stdout() {
        if (consumed) throw new Error('consumed instance accessed');
        return stdout;
      },
      get stderr() {
        if (consumed) throw new Error('consumed instance accessed');
        return stderr;
      },
      wait() {
        consumed = true;
        return Promise.resolve(output);
      },
    };

    const session = createWasmerSession(instance);

    expect(await session.exit).toBe(output);
    expect(() => session.dispose()).not.toThrow();
  });

  it('loads package bytes, mounts directories, and applies terminal environment defaults', async () => {
    supportWasmer();
    const instance = fakeInstance();
    const packageHandle = {
      entrypoint: { run: mocks.run },
      commands: {},
      free: mocks.packageFree,
    };
    mocks.fromFile.mockResolvedValue(packageHandle);
    mocks.run.mockResolvedValue(instance);
    const directory = await createWasmerDirectory({ '/README.md': 'hello' });

    const source = new Uint8Array([1, 2, 3]);
    const session = await createWasmerShell({
      package: { type: 'bytes', data: source },
      args: ['--norc'],
      env: { HOME: '/home/guest' },
      mount: { '/home/guest': directory },
      runtime: { registry: null },
    });

    source[0] = 9;
    expect(mocks.fromFile.mock.calls[0]?.[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--norc'],
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          HOME: '/home/guest',
        },
        mount: { '/home/guest': expect.anything() },
      })
    );

    session.dispose();
    directory.dispose();
    expect(mocks.packageFree).toHaveBeenCalledOnce();
    expect(mocks.runtimeFree).toHaveBeenCalledOnce();
    expect(mocks.directoryFree).toHaveBeenCalledOnce();
  });

  it('delegates directory operations and rejects access after disposal', async () => {
    supportWasmer();
    const directory = await createWasmerDirectory({ 'initial.txt': 'hello' });
    expect(await directory.readTextFile('initial.txt')).toBe('hello');
    await directory.writeFile('bytes.bin', new Uint8Array([1, 2]));
    await directory.writeFile('text.txt', 'value');
    expect(await directory.readFile('bytes.bin')).toEqual(new Uint8Array([1, 2]));
    expect(await directory.readTextFile('text.txt')).toBe('value');
    expect(await directory.readDir('/')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'initial.txt' }),
        expect.objectContaining({ name: 'bytes.bin' }),
      ])
    );
    await directory.createDir('folder');
    await directory.removeDir('folder');
    await directory.removeFile('text.txt');
    await expect(directory.readFile('text.txt')).rejects.toThrow('Missing');

    directory.dispose();
    directory.dispose();
    expect(mocks.directoryFree).toHaveBeenCalledOnce();
    expect(() => directory.readDir('/')).toThrow('disposed');
  });

  it('loads URL and named-command packages and cleans up failed startup', async () => {
    supportWasmer();
    const instance = fakeInstance();
    const command = { run: mocks.run };
    mocks.fromFile.mockResolvedValueOnce({
      entrypoint: command,
      commands: {},
      free: mocks.packageFree,
    });
    mocks.run.mockResolvedValue(instance);
    const fetchPackage = vi.fn(
      async () => new Response(new Uint8Array([4, 5, 6]), { status: 200, statusText: 'OK' })
    );
    const session = await createWasmerShell({
      package: { type: 'url', url: 'https://example.test/shell.webc', fetch: fetchPackage },
      runtime: { registry: 'https://registry.test' },
    });
    expect(fetchPackage).toHaveBeenCalledWith('https://example.test/shell.webc');
    expect(mocks.fromFile).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]), expect.anything());
    session.dispose();

    mocks.fromRegistry.mockResolvedValueOnce({
      entrypoint: undefined,
      commands: { bash: command },
      free: mocks.packageFree,
    });
    const named = await createWasmerShell({
      package: { type: 'registry', specifier: 'test/shell@1' },
      command: 'bash',
    });
    expect(mocks.fromRegistry).toHaveBeenCalledWith('test/shell@1', undefined);
    named.dispose();

    mocks.fromFile.mockResolvedValueOnce({
      entrypoint: undefined,
      commands: {},
      free: mocks.packageFree,
    });
    await expect(
      createWasmerShell({ package: { type: 'bytes', data: new Uint8Array([1]) } })
    ).rejects.toThrow('no entrypoint');
    expect(mocks.packageFree).toHaveBeenCalledTimes(3);
  });

  it('loads copied raw WASI module bytes without consulting the registry', async () => {
    supportWasmer();
    const source = new Uint8Array([0, 97, 115, 109]);
    const command = { run: mocks.run };
    mocks.fromWasm.mockReturnValue({
      entrypoint: command,
      commands: {},
      free: mocks.packageFree,
    });
    mocks.run.mockResolvedValue(fakeInstance());

    const session = await createWasmerShell({ package: { type: 'wasm', data: source } });

    expect(mocks.fromWasm).toHaveBeenCalledWith(source, undefined);
    expect(mocks.fromWasm.mock.calls[0]?.[0]).not.toBe(source);
    expect(mocks.fromFile).not.toHaveBeenCalled();
    expect(mocks.fromRegistry).not.toHaveBeenCalled();
    session.dispose();
    expect(mocks.packageFree).toHaveBeenCalledOnce();
  });

  it('reports URL failures and rejects foreign mount handles without leaking resources', async () => {
    supportWasmer();
    const failedFetch = vi.fn(
      async () =>
        new Response('missing', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'text/plain' },
        })
    );
    await expect(
      createWasmerShell({
        package: { type: 'url', url: 'https://example.test/missing.webc', fetch: failedFetch },
      })
    ).rejects.toThrow('Failed to load Wasmer package (404)');

    mocks.fromFile.mockResolvedValueOnce({
      entrypoint: { run: mocks.run },
      commands: {},
      free: mocks.packageFree,
    });
    const foreign = { dispose() {}, readFile: async () => new Uint8Array() };
    await expect(
      createWasmerShell({
        package: { type: 'bytes', data: new ArrayBuffer(1) },
        mount: { '/foreign': foreign as never },
      })
    ).rejects.toThrow('was not created');
    expect(mocks.packageFree).toHaveBeenCalledOnce();
  });

  it('tracks rejected exits, absent stdin, listener disposal, and terminal disposal guards', async () => {
    const failure = new Error('process failed');
    const instance: WasmerProcessInstance = {
      stdout: stream(new Uint8Array()),
      stderr: stream(new Uint8Array()),
      wait: async () => {
        throw failure;
      },
    };
    const session = createWasmerSession(instance);
    const status = vi.fn();
    const listener = session.onStatusChange(status);
    listener.dispose();
    await expect(session.exit).rejects.toBe(failure);
    expect(session.status).toBe('error');
    expect(session.error).toBe(failure);
    expect(session.capabilities.interactiveInput).toBe(false);
    expect(status).not.toHaveBeenCalled();

    session.dispose();
    await expect(session.close()).rejects.toThrow('disposed');
  });

  it('attaches through the existing terminal addon contract and owns its connection', async () => {
    supportWasmer();
    const instance = fakeInstance();
    mocks.fromRegistry.mockResolvedValue({
      entrypoint: { run: mocks.run },
      commands: {},
      free: mocks.packageFree,
    });
    mocks.run.mockResolvedValue(instance);
    const connection = { dispose: vi.fn() } as unknown as TerminalConnection;
    const terminal = {
      connect: vi.fn(() => connection),
    } as unknown as BrowserTerminal;
    const addon = new WasmerAddon({
      package: { type: 'registry', specifier: 'sharrattj/bash@1.0.17' },
    });

    addon.activate(terminal);
    const ready = await addon.ready;

    expect(terminal.connect).toHaveBeenCalledWith(ready.session.transport, undefined);
    expect(ready.connection).toBe(connection);

    addon.dispose();
    expect(connection.dispose).toHaveBeenCalledOnce();
    expect(mocks.packageFree).toHaveBeenCalledOnce();
  });

  it('releases a started session when the terminal rejects its transport', async () => {
    supportWasmer();
    const instance = fakeInstance();
    mocks.fromRegistry.mockResolvedValue({
      entrypoint: { run: mocks.run },
      commands: {},
      free: mocks.packageFree,
    });
    mocks.run.mockResolvedValue(instance);
    const terminal = {
      connect: vi.fn(() => {
        throw new Error('connection rejected');
      }),
    } as unknown as BrowserTerminal;
    const addon = new WasmerAddon({
      package: { type: 'registry', specifier: 'sharrattj/bash@1.0.17' },
    });

    addon.activate(terminal);

    await expect(addon.ready).rejects.toThrow('connection rejected');
    expect(mocks.packageFree).toHaveBeenCalledOnce();
  });
});

function supportWasmer(): void {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crossOriginIsolated', true);
  vi.stubGlobal('Worker', class Worker {});
}

function fakeInstance(
  overrides: Omit<Partial<WasmerProcessInstance>, 'wait'> & {
    wait?: Promise<WasmerProcessOutput>;
  } = {}
): WasmerProcessInstance {
  const wait = overrides.wait ?? Promise.resolve(output);
  return {
    stdin: overrides.stdin ?? new WritableStream<Uint8Array>(),
    stdout: overrides.stdout ?? stream(new Uint8Array()),
    stderr: overrides.stderr ?? stream(new Uint8Array()),
    wait: () => wait,
  };
}

function stream(chunk: string | Uint8Array): ReadableStream<string | Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

function streamChunks(
  chunks: readonly (string | Uint8Array)[]
): ReadableStream<string | Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

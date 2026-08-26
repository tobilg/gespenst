import type { BrowserTerminal, TerminalConnection } from '@gespenst/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketTransport, WebSocketAddon } from '../src';

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  binaryType = '';
  bufferedAmount = 0;
  readonly send = vi.fn();
  readonly close = vi.fn((code = 1000, reason = '') => {
    this.readyState = FakeSocket.CLOSED;
    const event = new Event('close');
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  });
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

function terminalFor(socket: FakeSocket): BrowserTerminal {
  const connection = {
    status: 'open',
    error: undefined,
    closed: new Promise<void>((resolve) => socket.addEventListener('close', () => resolve())),
    close: async () => undefined,
    dispose: () => undefined,
    onStatusChange: () => ({ dispose() {} }),
  } as TerminalConnection;
  return {
    geometry: { cols: 80, rows: 24 },
    connect: () => connection,
    on: () => ({ dispose() {} }),
  } as unknown as BrowserTerminal;
}

describe('@gespenst/websocket', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not reconnect after a clean close', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const socket = new FakeSocket();
    let creations = 0;
    const addon = new WebSocketAddon('ws://test', {
      reconnect: { initialDelayMs: 0 },
      createSocket: () => {
        creations += 1;
        return socket as unknown as WebSocket;
      },
    });
    addon.activate(terminalFor(socket));
    expect(() => addon.activate(terminalFor(socket))).toThrow(/already active/u);
    socket.open();
    await addon.ready;
    socket.close(1000, 'shell exited');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(addon.status).toBe('closed');
    expect(creations).toBe(1);
    addon.dispose();
    addon.dispose();
    vi.unstubAllGlobals();
  });

  it('rejects ready when disposed before open and closes on an exit frame', async () => {
    const socket = new FakeSocket();
    const addon = new WebSocketAddon('ws://test', {
      createSocket: () => socket as unknown as WebSocket,
    });
    addon.activate(terminalFor(socket));
    addon.dispose();
    await expect(addon.ready).rejects.toMatchObject({ name: 'AbortError' });

    const transportSocket = new FakeSocket();
    transportSocket.readyState = FakeSocket.OPEN;
    const reader = socketTransport(transportSocket as unknown as WebSocket).readable.getReader();
    transportSocket.message(JSON.stringify({ type: 'exit' }));
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(transportSocket.close).toHaveBeenCalledWith(1000, 'PTY exited');
  });

  it('sends hello and resize frames and reconnects only after unexpected closure', async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    let resize: ((value: { cols: number; rows: number }) => void) | undefined;
    const connection = (socket: FakeSocket) => ({
      status: 'open',
      error: undefined,
      closed: new Promise<void>((resolve) => socket.addEventListener('close', () => resolve())),
      close: async () => undefined,
      dispose: vi.fn(),
      onStatusChange: () => ({ dispose() {} }),
    });
    const terminal = {
      geometry: { cols: 80, rows: 24 },
      connect: vi.fn(() => connection(first)),
      on: vi.fn((_type, listener) => {
        resize = listener;
        return { dispose: vi.fn() };
      }),
    } as unknown as BrowserTerminal;
    const statuses: string[] = [];
    const addon = new WebSocketAddon('ws://test', {
      reconnect: { initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 2 },
      createSocket: () => sockets.shift() as unknown as WebSocket,
    });
    addon.onStatusChange((status) => statuses.push(status));
    addon.activate(terminal);
    first.open();
    await addon.ready;
    expect(JSON.parse(String(first.send.mock.calls[0]?.[0]))).toEqual({
      type: 'hello',
      version: 1,
      cols: 80,
      rows: 24,
    });
    resize?.({ cols: 100, rows: 30 });
    expect(JSON.parse(String(first.send.mock.calls[1]?.[0]))).toEqual({
      type: 'resize',
      cols: 100,
      rows: 30,
    });

    first.close(1006, 'network lost');
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(statuses).toContain('reconnecting');
    second.open();
    await Promise.resolve();
    expect(addon.status).toBe('connected');
    addon.dispose();
  });

  it('rejects startup after reconnect attempts are exhausted', async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const addon = new WebSocketAddon('ws://test', {
      reconnect: { initialDelayMs: 1, maxAttempts: 1 },
      createSocket: () => sockets.shift() as unknown as WebSocket,
    });
    addon.activate(terminalFor(first));
    first.fail();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
    second.fail();
    await expect(addon.ready).rejects.toThrow('WebSocket connection failed');
    expect(addon.status).toBe('error');
  });

  it('preserves mixed binary message order and reports invalid control frames', async () => {
    const socket = new FakeSocket();
    socket.readyState = FakeSocket.OPEN;
    const reader = socketTransport(socket as unknown as WebSocket).readable.getReader();
    socket.message(new Blob([new Uint8Array([1])]));
    socket.message(new Uint8Array([2]).buffer);
    await expect(reader.read()).resolves.toMatchObject({ value: new Uint8Array([1]) });
    await expect(reader.read()).resolves.toMatchObject({ value: new Uint8Array([2]) });
    await reader.cancel('done');

    for (const control of [
      'not-json',
      JSON.stringify({ type: 'error', message: 'server failed' }),
    ]) {
      const failed = new FakeSocket();
      failed.readyState = FakeSocket.OPEN;
      const failedReader = socketTransport(failed as unknown as WebSocket).readable.getReader();
      failed.message(control);
      await expect(failedReader.read()).rejects.toThrow(
        control === 'not-json' ? 'Invalid WebSocket control message' : 'server failed'
      );
    }
  });

  it('handles writable sends, backpressure closure, close, abort, and readable cancellation', async () => {
    vi.stubGlobal('WebSocket', undefined);
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.readyState = FakeSocket.OPEN;
    const transport = socketTransport(socket as unknown as WebSocket);
    const writer = transport.writable.getWriter();
    await writer.write(new Uint8Array([1, 2]));
    expect(socket.send.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);

    socket.bufferedAmount = 2 * 1024 * 1024;
    const blocked = writer.write(new Uint8Array([3]));
    const blockedExpectation = expect(blocked).rejects.toThrow('closed while writing');
    socket.readyState = FakeSocket.CLOSED;
    await vi.advanceTimersByTimeAsync(4);
    await blockedExpectation;

    const closing = new FakeSocket();
    closing.readyState = FakeSocket.OPEN;
    await socketTransport(closing as unknown as WebSocket)
      .writable.getWriter()
      .close();
    expect(closing.close).toHaveBeenCalledWith(1000, 'Terminal input closed');

    const aborting = new FakeSocket();
    aborting.readyState = FakeSocket.OPEN;
    await socketTransport(aborting as unknown as WebSocket)
      .writable.getWriter()
      .abort('failed');
    expect(aborting.close).toHaveBeenCalledWith(1011, 'failed');

    const cancelling = new FakeSocket();
    cancelling.readyState = FakeSocket.OPEN;
    await socketTransport(cancelling as unknown as WebSocket).readable.cancel('closed');
    expect(cancelling.close).toHaveBeenCalledWith(1000, 'closed');
  });
});

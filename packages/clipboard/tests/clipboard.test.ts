import type { BrowserTerminal, ClipboardPasteResult, Disposable } from '@gespenst/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClipboardAddon, type ClipboardAddonError } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('@gespenst/clipboard', () => {
  it('enables opt-in protocol support and reads text during user activation', async () => {
    const value = fakeTerminal([{ status: 'written', kind: 'text' }]);
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'hello') } });
    const addon = new ClipboardAddon();
    addon.activate(value.terminal);
    await addon.ready;

    await expect(addon.pasteFromClipboard()).resolves.toEqual({
      status: 'written',
      kind: 'text',
    });
    expect(value.enableClipboard).toHaveBeenCalledWith({
      maxBytes: 32 * 1024 * 1024,
      snapshotTtlMs: 30_000,
    });
    expect(value.pasteClipboard).toHaveBeenCalledWith({
      contents: [{ mime: 'text/plain', data: new TextEncoder().encode('hello') }],
      location: 'standard',
    });

    addon.dispose();
    expect(value.registrationDispose).toHaveBeenCalledOnce();
  });

  it('requires explicit confirmation before retrying unsafe fallback text', async () => {
    const value = fakeTerminal([{ status: 'unsafe' }, { status: 'written', kind: 'text' }]);
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'echo hello\n') } });
    const confirmUnsafePaste = vi.fn(async () => true);
    const addon = new ClipboardAddon({ confirmUnsafePaste, location: 'primary' });
    addon.activate(value.terminal);

    await expect(addon.pasteFromClipboard()).resolves.toEqual({
      status: 'written',
      kind: 'text',
    });
    expect(confirmUnsafePaste).toHaveBeenCalledWith({
      text: 'echo hello\n',
      mime: 'text/plain',
      byteLength: 11,
      location: 'primary',
    });
    expect(value.pasteClipboard).toHaveBeenLastCalledWith(
      expect.objectContaining({ location: 'primary', allowUnsafe: true })
    );
    addon.dispose();
  });

  it('forwards binary MIME representations and removes duplicate types', async () => {
    const value = fakeTerminal([{ status: 'written', kind: 'kitty' }]);
    const first = {
      types: ['image/png', 'text/plain'],
      getType: vi.fn(async (mime: string) =>
        mime === 'image/png' ? new Blob([new Uint8Array([1, 2, 3])]) : new Blob(['first'])
      ),
    };
    const duplicate = {
      types: ['text/plain'],
      getType: vi.fn(async () => new Blob(['second'])),
    };
    vi.stubGlobal('navigator', {
      clipboard: { read: vi.fn(async () => [first, duplicate]) },
    });
    const addon = new ClipboardAddon();
    addon.activate(value.terminal);

    await expect(addon.pasteFromClipboard()).resolves.toEqual({
      status: 'written',
      kind: 'kitty',
    });
    expect(duplicate.getType).not.toHaveBeenCalled();
    expect(value.pasteClipboard).toHaveBeenCalledWith({
      contents: [
        { mime: 'image/png', data: new Uint8Array([1, 2, 3]) },
        { mime: 'text/plain', data: new TextEncoder().encode('first') },
      ],
      location: 'standard',
    });
    addon.dispose();
  });

  it('reports browser permission denial and enforces the byte limit', async () => {
    const value = fakeTerminal([]);
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: vi.fn(async () => {
          throw new DOMException('denied', 'NotAllowedError');
        }),
      },
    });
    const addon = new ClipboardAddon();
    addon.activate(value.terminal);
    await expect(addon.pasteFromClipboard()).rejects.toMatchObject({
      code: 'permission-denied',
    });
    addon.dispose();

    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn(async () => 'too long') } });
    const limited = new ClipboardAddon({ maxBytes: 3 });
    limited.activate(fakeTerminal([]).terminal);
    await expect(limited.pasteFromClipboard()).rejects.toMatchObject({ code: 'too-large' });
    limited.dispose();
  });

  it('settles ready and releases late registrations when disposed during startup', async () => {
    let resolveRegistration!: (value: Disposable) => void;
    const registrationDispose = vi.fn();
    const terminal = {
      element: new EventTarget(),
      enableClipboard: vi.fn(
        () =>
          new Promise<Disposable>((resolve) => {
            resolveRegistration = resolve;
          })
      ),
    } as unknown as BrowserTerminal;
    const addon = new ClipboardAddon();
    addon.activate(terminal);
    addon.dispose();
    await expect(addon.ready).rejects.toEqual(
      expect.objectContaining<Partial<ClipboardAddonError>>({ code: 'disposed' })
    );
    resolveRegistration({ dispose: registrationDispose });
    await Promise.resolve();
    expect(registrationDispose).toHaveBeenCalledOnce();
  });
});

function fakeTerminal(results: ClipboardPasteResult[]) {
  const registrationDispose = vi.fn();
  const enableClipboard = vi.fn(async () => ({ dispose: registrationDispose }));
  const pasteClipboard = vi.fn(async () => results.shift() ?? { status: 'empty' as const });
  const terminal = {
    element: new EventTarget(),
    enableClipboard,
    pasteClipboard,
  } as unknown as BrowserTerminal;
  return { terminal, registrationDispose, enableClipboard, pasteClipboard };
}

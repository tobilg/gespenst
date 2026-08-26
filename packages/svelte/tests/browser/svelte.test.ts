import type { BrowserTerminal } from '@gespenst/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createTerminal: vi.fn() }));
vi.mock('@gespenst/core', () => ({ createTerminal: mocks.createTerminal }));

import { gespenstTerminal } from '../../src';

afterEach(() => {
  vi.clearAllMocks();
});

describe('@gespenst/svelte', () => {
  it('applies the latest mutable options after asynchronous startup', async () => {
    const pending = deferred<BrowserTerminal>();
    const created = fakeTerminal();
    const ready = vi.fn();
    mocks.createTerminal.mockReturnValue(pending.promise);
    const action = gespenstTerminal(document.createElement('div'), {
      fontFamily: 'Initial',
      onReady: vi.fn(),
    });

    action.update({
      fontFamily: 'Latest',
      fontSizePx: 16,
      fontWeight: 500,
      fontWeightBold: 800,
      lineHeight: 1.4,
      letterSpacingPx: 1,
      theme: { foreground: '#ffffff' },
      onReady: ready,
    });
    pending.resolve(created.terminal);
    await settle();

    expect(created.setFont).toHaveBeenCalledWith({
      family: 'Latest',
      sizePx: 16,
      weight: 500,
      boldWeight: 800,
      lineHeight: 1.4,
      letterSpacingPx: 1,
    });
    expect(created.setTheme).toHaveBeenCalledWith({ foreground: '#ffffff' });
    expect(ready).toHaveBeenCalledWith(created.terminal);
    action.destroy();
    expect(created.dispose).toHaveBeenCalledOnce();
  });

  it('disposes late creation and reports errors only while active', async () => {
    const pending = deferred<BrowserTerminal>();
    const created = fakeTerminal();
    const ready = vi.fn();
    mocks.createTerminal.mockReturnValueOnce(pending.promise);
    const action = gespenstTerminal(document.createElement('div'), { onReady: ready });
    action.destroy();
    pending.resolve(created.terminal);
    await settle();
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();

    const error = vi.fn();
    mocks.createTerminal.mockRejectedValueOnce('failed');
    gespenstTerminal(document.createElement('div'), { onError: error });
    await settle();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed' }));
  });

  it('does not apply font or theme calls when no mutable values are supplied', async () => {
    const created = fakeTerminal();
    mocks.createTerminal.mockResolvedValue(created.terminal);
    gespenstTerminal(document.createElement('div'));
    await settle();
    expect(created.setFont).not.toHaveBeenCalled();
    expect(created.setTheme).not.toHaveBeenCalled();
  });
});

function fakeTerminal() {
  const dispose = vi.fn();
  const setFont = vi.fn(async () => ({}) as never);
  const setTheme = vi.fn(async () => undefined);
  return {
    dispose,
    setFont,
    setTheme,
    terminal: { dispose, setFont, setTheme } as unknown as BrowserTerminal,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

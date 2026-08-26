import type { BrowserTerminal } from '@gespenst/core';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createTerminal: vi.fn() }));
vi.mock('@gespenst/core', () => ({ createTerminal: mocks.createTerminal }));

import { GespenstTerminal, useGespenstTerminal } from '../../src';

const roots: Array<ReturnType<typeof createRoot>> = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('@gespenst/react', () => {
  it('exposes readiness without recreating for callback identity changes', async () => {
    const created = fakeTerminal();
    mocks.createTerminal.mockResolvedValue(created.terminal);
    const firstReady = vi.fn();
    const secondReady = vi.fn();
    const root = mountedRoot();

    await act(async () => {
      root.render(createElement(GespenstTerminal, { onReady: firstReady, className: 'terminal' }));
      await flushPromises();
    });
    expect(firstReady).toHaveBeenCalledWith(created.terminal);
    expect(mocks.createTerminal).toHaveBeenCalledOnce();

    await act(() =>
      root.render(createElement(GespenstTerminal, { onReady: secondReady, className: 'terminal' }))
    );
    await settle();
    expect(mocks.createTerminal).toHaveBeenCalledOnce();
    expect(secondReady).not.toHaveBeenCalled();

    await act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(created.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a terminal that resolves after unmount and suppresses callbacks', async () => {
    const pending = deferred<BrowserTerminal>();
    const created = fakeTerminal();
    const ready = vi.fn();
    mocks.createTerminal.mockReturnValue(pending.promise);
    const root = mountedRoot();
    await act(() => root.render(createElement(GespenstTerminal, { onReady: ready })));
    await act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);

    pending.resolve(created.terminal);
    await settle();
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
  });

  it('reports initialization errors and exposes the managed hook state', async () => {
    const error = vi.fn();
    mocks.createTerminal.mockRejectedValue('startup failed');
    const root = mountedRoot();
    await act(async () => {
      root.render(createElement(GespenstTerminal, { onTerminalError: error }));
      await flushPromises();
    });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'startup failed' }));

    const created = fakeTerminal();
    function Harness() {
      const managed = useGespenstTerminal();
      useEffect(() => managed.setTerminal(created.terminal), [managed.setTerminal]);
      return createElement('div', {
        ref: managed.ref,
        'data-ready': managed.terminal ? 'yes' : 'no',
      });
    }
    await act(() => root.render(createElement(Harness)));
    await settle();
    expect(document.querySelector('[data-ready="yes"]')).not.toBeNull();
  });

  it('forwards every defined terminal option and preserves host attributes', async () => {
    const created = fakeTerminal();
    mocks.createTerminal.mockResolvedValue(created.terminal);
    const root = mountedRoot();
    const wasm = new Uint8Array([0]);
    const callbacksWasm = new Uint8Array([1]);
    await act(async () => {
      root.render(
        createElement(GespenstTerminal, {
          className: 'configured-terminal',
          style: { minHeight: '12px' },
          worker: false,
          renderer: 'canvas2d',
          allowTransparency: true,
          minimumContrastRatio: 4.5,
          fontFamily: 'Test Mono',
          fontSizePx: 18,
          lineHeight: 1.2,
          fontWeight: 400,
          fontWeightBold: 700,
          letterSpacingPx: 1,
          accessibility: 'full',
          ariaLabel: 'Configured terminal',
          wasm,
          callbacksWasm,
          cols: 100,
          rows: 30,
          cellWidthPx: 10,
          cellHeightPx: 20,
          scrollbackLines: 5_000,
          theme: { foreground: '#ffffff' },
        })
      );
      await flushPromises();
    });

    expect(mocks.createTerminal).toHaveBeenCalledWith({
      container: expect.any(HTMLElement),
      worker: false,
      renderer: 'canvas2d',
      allowTransparency: true,
      minimumContrastRatio: 4.5,
      fontFamily: 'Test Mono',
      fontSizePx: 18,
      lineHeight: 1.2,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacingPx: 1,
      accessibility: 'full',
      ariaLabel: 'Configured terminal',
      wasm,
      callbacksWasm,
      cols: 100,
      rows: 30,
      cellWidthPx: 10,
      cellHeightPx: 20,
      scrollbackLines: 5_000,
      theme: { foreground: '#ffffff' },
    });
    const element = document.querySelector<HTMLElement>('.configured-terminal');
    expect(element?.style.width).toBe('100%');
    expect(element?.style.minHeight).toBe('12px');
  });

  it('forwards Error instances without wrapping them', async () => {
    const failure = new Error('native failure');
    const onTerminalError = vi.fn();
    mocks.createTerminal.mockRejectedValue(failure);
    const root = mountedRoot();
    await act(async () => {
      root.render(createElement(GespenstTerminal, { onTerminalError }));
      await flushPromises();
    });
    expect(onTerminalError).toHaveBeenCalledWith(failure);
  });
});

function mountedRoot() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  return root;
}

function fakeTerminal() {
  const dispose = vi.fn();
  return {
    dispose,
    terminal: { dispose } as unknown as BrowserTerminal,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await act(async () => {
    await flushPromises();
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

import type { BrowserTerminal } from '@gespenst/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';

const mocks = vi.hoisted(() => ({ createTerminal: vi.fn() }));
vi.mock('@gespenst/core', () => ({ createTerminal: mocks.createTerminal }));

import { GespenstTerminal, useGespenstTerminal } from '../../src';

const apps: Array<ReturnType<typeof createApp>> = [];

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('@gespenst/vue', () => {
  it('mounts the component, emits ready, merges attributes, and disposes', async () => {
    const created = fakeTerminal();
    const ready = vi.fn();
    mocks.createTerminal.mockResolvedValue(created.terminal);
    const app = createApp(GespenstTerminal, {
      options: { fontFamily: 'Test' },
      class: 'host',
      style: { minHeight: '10px' },
      onReady: ready,
    });
    apps.push(app);
    const host = mount(app);
    await settle();

    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ fontFamily: 'Test', container: expect.any(HTMLElement) })
    );
    expect(ready).toHaveBeenCalledWith(created.terminal);
    expect(host.querySelector('.host')).not.toBeNull();
    app.unmount();
    apps.splice(apps.indexOf(app), 1);
    expect(created.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a component terminal that resolves after unmount and suppresses errors', async () => {
    const pending = deferred<BrowserTerminal>();
    const created = fakeTerminal();
    const ready = vi.fn();
    mocks.createTerminal.mockReturnValueOnce(pending.promise);
    const app = createApp(GespenstTerminal, { onReady: ready });
    apps.push(app);
    mount(app);
    app.unmount();
    apps.splice(apps.indexOf(app), 1);
    pending.resolve(created.terminal);
    await settle();
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();

    const error = vi.fn();
    mocks.createTerminal.mockRejectedValueOnce('failed');
    const failed = createApp(GespenstTerminal, { onError: error });
    apps.push(failed);
    mount(failed);
    await settle();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed' }));

    const cancelledFailure = deferred<BrowserTerminal>();
    const ignoredError = vi.fn();
    mocks.createTerminal.mockReturnValueOnce(cancelledFailure.promise);
    const cancelled = createApp(GespenstTerminal, { onError: ignoredError });
    apps.push(cancelled);
    mount(cancelled);
    cancelled.unmount();
    apps.splice(apps.indexOf(cancelled), 1);
    cancelledFailure.reject(new Error('late failure'));
    await settle();
    expect(ignoredError).not.toHaveBeenCalled();

    const nativeFailure = new Error('native failure');
    const nativeError = vi.fn();
    mocks.createTerminal.mockRejectedValueOnce(nativeFailure);
    const nativeFailed = createApp(GespenstTerminal, { onError: nativeError });
    apps.push(nativeFailed);
    mount(nativeFailed);
    await settle();
    expect(nativeError).toHaveBeenCalledWith(nativeFailure);
  });

  it('owns composable creation and disposes late results', async () => {
    const pending = deferred<BrowserTerminal>();
    const created = fakeTerminal();
    mocks.createTerminal.mockReturnValue(pending.promise);
    let exposed: ReturnType<typeof useGespenstTerminal> | undefined;
    const Harness = defineComponent({
      setup() {
        const managed = useGespenstTerminal({ rows: 5 });
        exposed = managed;
        return () => h('div', { ref: managed.container });
      },
    });
    const app = createApp(Harness);
    apps.push(app);
    mount(app);
    await nextTick();
    app.unmount();
    apps.splice(apps.indexOf(app), 1);
    pending.resolve(created.terminal);
    await settle();
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(exposed?.terminal.value).toBeNull();
  });

  it('exposes and disposes a successfully created composable terminal', async () => {
    const created = fakeTerminal();
    mocks.createTerminal.mockResolvedValue(created.terminal);
    let exposed: ReturnType<typeof useGespenstTerminal> | undefined;
    const Harness = defineComponent({
      setup() {
        const managed = useGespenstTerminal();
        exposed = managed;
        return () => h('div', { ref: managed.container });
      },
    });
    const app = createApp(Harness);
    apps.push(app);
    mount(app);
    await settle();
    expect(exposed?.terminal.value).toBe(created.terminal);
    app.unmount();
    apps.splice(apps.indexOf(app), 1);
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(exposed?.terminal.value).toBeNull();
  });
});

function mount(app: ReturnType<typeof createApp>): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  app.mount(host);
  return host;
}

function fakeTerminal() {
  const dispose = vi.fn();
  return { dispose, terminal: { dispose } as unknown as BrowserTerminal };
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
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
}

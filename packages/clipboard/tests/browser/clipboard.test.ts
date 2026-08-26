import { type BrowserTerminal, createTerminal } from '@gespenst/core';
import { describe, expect, it, vi } from 'vitest';
import { ClipboardAddon } from '../../src/index.js';

describe('@gespenst/clipboard browser integration', () => {
  for (const worker of [false, 'dedicated'] as const) {
    it(`intercepts native paste with the ${String(worker)} backend`, async () => {
      const container = document.createElement('div');
      container.style.cssText = 'width:640px;height:160px';
      document.body.append(container);
      const terminal = await createTerminal({ container, worker });
      const addon = new ClipboardAddon();
      terminal.loadAddon(addon);
      await addon.ready;
      const input: string[] = [];
      terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));

      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'browser paste');
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      terminal.element.dispatchEvent(event);
      await waitFor(() => input.includes('browser paste'));

      expect(event.defaultPrevented).toBe(true);
      addon.dispose();
      terminal.dispose();
      container.remove();
    });
  }

  it('reports asynchronous native-paste failures through onError', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const onError = vi.fn();
    const terminal = {
      element,
      enableClipboard: vi.fn(async () => ({ dispose() {} })),
      pasteClipboard: vi.fn(),
    } as unknown as BrowserTerminal;
    const addon = new ClipboardAddon({ maxBytes: 3, onError });
    addon.activate(terminal);
    await addon.ready;
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'too large');
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    element.dispatchEvent(event);
    await waitFor(() => onError.mock.calls.length === 1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'too-large' }));
    expect(event.defaultPrevented).toBe(true);
    addon.dispose();
    element.remove();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for clipboard input');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

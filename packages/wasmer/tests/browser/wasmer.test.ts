import { createTerminal } from '@gespenst/core';
import { wat2wasm } from '@wasmer/sdk';
import { describe, expect, it } from 'vitest';
import { getWasmerBrowserSupport, initializeWasmer, WasmerAddon } from '../../src';
import commandFixture from '../fixtures/command.wat?raw';

describe('@gespenst/wasmer browser integration', () => {
  it('initializes the real Wasmer SDK in a cross-origin-isolated browser', async () => {
    const support = getWasmerBrowserSupport();

    expect(support).toMatchObject({
      supported: true,
      secureContext: true,
      crossOriginIsolated: true,
      missing: [],
    });
    await initializeWasmer();
  }, 30_000);

  it('runs a WASI process through a real terminal transport', async () => {
    const host = document.createElement('div');
    host.style.width = '480px';
    host.style.height = '160px';
    document.body.append(host);
    const terminal = await createTerminal({
      container: host,
      cols: 48,
      rows: 6,
      worker: false,
      renderer: 'canvas2d',
    });
    const shell = new WasmerAddon({
      package: { type: 'wasm', data: wat2wasm(commandFixture) },
    });
    try {
      terminal.loadAddon(shell);
      const { connection, session } = await shell.ready;

      await expect(session.exit).resolves.toMatchObject({ code: 0, ok: true });
      await expect(connection.closed).resolves.toBeUndefined();
      const text = (await terminal.readViewport()).viewportRows.map((row) => row.text).join('\n');
      expect(text).toContain('wasix fixture ok');
      expect(session.capabilities.interactiveInput).toBe(true);
      expect(session.status).toBe('exited');
      expect(connection.status).toBe('closed');
    } finally {
      terminal.dispose();
      host.remove();
    }
  }, 60_000);
});

import { describe, expect, it } from 'vitest';
import { createCoreRuntime, KeyModifiers } from '../src/core';

describe('Ghostty core runtime', () => {
  it('parses VT, renders rows, and emits terminal effects', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 20, rows: 4 });
    const bells: undefined[] = [];
    const titles: string[] = [];
    terminal.on('bell', (event) => bells.push(event));
    terminal.on('title', (title) => titles.push(title));

    terminal.write('\u001b]2;Ghostty test\u0007hello \u001b[31mred\u001b[0m\u0007');
    const viewport = terminal.viewport();

    expect(viewport.cols).toBe(20);
    expect(viewport.viewportRows[0]?.text).toContain('hello red');
    expect(viewport.viewportRows[0]?.cells.some((cell) => cell.foreground !== null)).toBe(true);
    expect(bells).toHaveLength(1);
    expect(titles).toEqual(['Ghostty test']);

    terminal.dispose();
    runtime.dispose();
  });

  it('encodes input, paste modes, selection, and snapshots', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 10, rows: 2 });
    const input: string[] = [];
    terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));

    expect(
      new TextDecoder().decode(
        terminal.key({ code: 'KeyC', text: 'c', modifiers: KeyModifiers.control })
      )
    ).toBe('\u0003');
    terminal.write('\u001b[?2004hline one\r\nline two');
    expect(new TextDecoder().decode(terminal.paste('x'))).toBe('\u001b[200~x\u001b[201~');
    terminal.selectAll();
    expect(terminal.getSelection()).toContain('line one');

    const snapshot = terminal.snapshot();
    terminal.reset();
    terminal.restore(snapshot);
    expect(
      terminal
        .viewport()
        .viewportRows.map((row) => row.text)
        .join('\n')
    ).toContain('line');
    expect(input.length).toBeGreaterThanOrEqual(2);

    runtime.dispose();
  });

  it('uses Ghostty selection gestures and mouse protocols', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({
      cols: 20,
      rows: 2,
      cellWidthPx: 10,
      cellHeightPx: 20,
    });
    terminal.write('hello world');
    terminal.pointer({
      action: 'press',
      button: 'left',
      x: 1,
      y: 1,
      anyButtonPressed: true,
      timeMs: 1,
    });
    terminal.pointer({ action: 'motion', button: 'left', x: 49, y: 1, anyButtonPressed: true });
    terminal.pointer({ action: 'release', button: 'left', x: 49, y: 1 });
    expect(terminal.getSelection()).toBe('hello');

    const input: string[] = [];
    terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));
    terminal.write('\u001b[?1000h\u001b[?1006h');
    terminal.pointer({ action: 'press', button: 'left', x: 1, y: 1, anyButtonPressed: true });
    expect(input.at(-1)).toBe('\u001b[<0;1;1M');
    runtime.dispose();
  });

  it('routes OSC effects through the official callback table', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal();
    const cwd: string[] = [];
    const notifications: string[] = [];
    const progress: Array<{ state: string; progress: number | null }> = [];
    const clipboard: string[] = [];
    terminal.on('cwd', (value) => cwd.push(value));
    terminal.on('notification', ({ body }) => notifications.push(body));
    terminal.on('progress', (value) => progress.push(value));
    terminal.on('clipboardWrite', (request) => {
      const text = request.contents.find((content) => content.mime === 'text/plain');
      if (text) clipboard.push(new TextDecoder().decode(text.data));
    });

    terminal.write(
      '\u001b]7;file://localhost/tmp\u0007' +
        '\u001b]9;hello notification\u0007' +
        '\u001b]9;4;1;50\u0007' +
        '\u001b]52;c;aGVsbG8=\u0007'
    );

    expect(cwd.at(-1)).toContain('/tmp');
    expect(notifications).toContain('hello notification');
    expect(progress.at(-1)).toMatchObject({ state: 'set', progress: 50 });
    expect(clipboard).toContain('hello');
    runtime.dispose();
  });

  it('bridges user-authorized MIME pastes through the Kitty clipboard protocol', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal();
    const replies: string[] = [];
    terminal.on('input', ({ data }) => replies.push(new TextDecoder().decode(data)));
    const registration = terminal.enableClipboard();

    terminal.write('\x1b[?5522h');
    expect(
      terminal.pasteClipboard({
        contents: [
          { mime: 'text/plain', data: new TextEncoder().encode('hello') },
          { mime: 'image/png', data: new Uint8Array([1, 2, 3]) },
        ],
      })
    ).toEqual({ status: 'written', kind: 'kitty' });
    const password = replies.join('').split(':pw=')[1]?.split('\x1b')[0]?.split(';')[0];
    expect(password).toBeTruthy();

    replies.length = 0;
    terminal.write(
      `\x1b]5522;type=read:pw=${password}:name=UGFzdGUgZXZlbnQ=;dGV4dC9wbGFpbg==\x1b\\`
    );
    expect(replies.join('')).toContain('mime=dGV4dC9wbGFpbg==;aGVsbG8=');
    expect(replies.join('')).toContain('status=DONE');
    replies.length = 0;
    terminal.write(
      `\x1b]5522;type=read:pw=${password}:name=UGFzdGUgZXZlbnQ=;dGV4dC9wbGFpbg==\x1b\\`
    );
    expect(replies.join('')).toContain('status=EPERM');

    registration.dispose();
    expect(() =>
      terminal.pasteClipboard({
        contents: [{ mime: 'text/plain', data: new TextEncoder().encode('again') }],
      })
    ).toThrow('not enabled');
    runtime.dispose();
  });

  it('expires Kitty clipboard snapshots and enforces the core byte limit', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal();
    const replies: string[] = [];
    terminal.on('input', ({ data }) => replies.push(new TextDecoder().decode(data)));
    terminal.enableClipboard({ maxBytes: 5, snapshotTtlMs: 1 });
    expect(() =>
      terminal.pasteClipboard({
        contents: [{ mime: 'text/plain', data: new TextEncoder().encode('123456') }],
      })
    ).toThrow('exceed 5 bytes');

    terminal.write('\x1b[?5522h');
    terminal.pasteClipboard({
      contents: [{ mime: 'text/plain', data: new TextEncoder().encode('hello') }],
    });
    const password = replies.join('').split(':pw=')[1]?.split('\x1b')[0]?.split(';')[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    replies.length = 0;
    terminal.write(
      `\x1b]5522;type=read:pw=${password}:name=UGFzdGUgZXZlbnQ=;dGV4dC9wbGFpbg==\x1b\\`
    );
    expect(replies.join('')).toContain('status=EPERM');
    runtime.dispose();
  });

  it('rejects unsafe fallback text and remote clipboard writes by default', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal();
    const input: string[] = [];
    const writes: string[] = [];
    terminal.on('input', ({ data }) => input.push(new TextDecoder().decode(data)));
    terminal.on('clipboardWrite', ({ contents }) => {
      const text = contents.find(({ mime }) => mime === 'text/plain');
      if (text) writes.push(new TextDecoder().decode(text.data));
    });
    const registration = terminal.enableClipboard({ maxBytes: 32 });

    const contents = [{ mime: 'text/plain', data: new TextEncoder().encode('echo unsafe\n') }];
    expect(terminal.pasteClipboard({ contents })).toEqual({ status: 'unsafe' });
    expect(terminal.pasteClipboard({ contents, allowUnsafe: true })).toEqual({
      status: 'written',
      kind: 'text',
    });
    expect(input).toContain('echo unsafe\r');

    const osc = '\x1b]5522;';
    const st = '\x1b\\';
    terminal.write(
      `${osc}type=write${st}` +
        `${osc}type=wdata:mime=dGV4dC9wbGFpbg==;cmVtb3Rl${st}` +
        `${osc}type=wdata${st}`
    );
    expect(writes).toEqual(['remote']);
    expect(input.join('')).toContain('type=write:status=EPERM');
    registration.dispose();
    input.length = 0;
    terminal.write(
      `${osc}type=write${st}` +
        `${osc}type=wdata:mime=dGV4dC9wbGFpbg==;YWdhaW4=${st}` +
        `${osc}type=wdata${st}`
    );
    expect(input.join('')).toContain('type=write:status=ENOSYS');
    runtime.dispose();
  });

  it('exposes retained scrollback through authoritative paged buffer coordinates', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 5, rows: 2 });
    terminal.write('one\r\ntwo\r\nthree');

    const buffer = terminal.readBuffer({ start: 0, end: 100 });
    expect(buffer.state).toMatchObject({
      screen: 'normal',
      totalRows: 3,
      scrollbackRows: 1,
      viewportY: 1,
      viewportLength: 2,
    });
    expect(buffer.rows.map((row) => row.text)).toEqual(['one', 'two', 'three']);
    expect(new Set(buffer.rows.map((row) => row.id)).size).toBe(3);

    terminal.scrollToTop();
    expect(terminal.bufferState().viewportY).toBe(0);
    expect(terminal.readBuffer().rows.map((row) => row.text)).toEqual(['one', 'two']);
    runtime.dispose();
  });

  it('preserves tab and cursor-positioned gaps in paged buffer text', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 16, rows: 2 });
    terminal.write('alpha\tbeta');
    expect(terminal.readBuffer().rows[0]?.text).toBe('alpha   beta');

    terminal.reset();
    terminal.write('a\x1b[10Gb');
    expect(terminal.readBuffer().rows[0]?.text).toBe('a        b');
    runtime.dispose();
  });

  it('exposes authoritative modes, raw colors, cursor attributes, and OSC 8 URIs', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 12, rows: 2 });
    terminal.write(
      '\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[4h' +
        '\x1b[38;5;42m\x1b]8;;https://example.com\x07link\x1b]8;;\x07'
    );

    const snapshot = terminal.readBuffer();
    expect(snapshot.state.modes).toMatchObject({
      applicationCursorKeysMode: true,
      applicationKeypadMode: true,
      bracketedPasteMode: true,
      insertMode: true,
    });
    expect(snapshot.state.cursorAttributes?.foreground).toEqual({ mode: 'palette', value: 42 });
    expect(snapshot.rows[0]?.cells[0]).toMatchObject({
      foregroundSource: { mode: 'palette', value: 42 },
      hyperlink: true,
      hyperlinkUri: 'https://example.com',
    });

    terminal.setScrollbackLines(20);
    terminal.setDefaultCursor('bar', true);
    runtime.dispose();
  });
});

import type {
  BrowserTerminal,
  BrowserTerminalEventMap,
  Disposable,
  RenderCell,
  ViewportSnapshot,
} from '@gespenst/core';
import { describe, expect, it, vi } from 'vitest';
import { WebLinksAddon } from '../../src';

describe('@gespenst/web-links', () => {
  it('accepts non-global patterns and refreshes on viewport changes', async () => {
    const element = document.createElement('div');
    element.style.width = '300px';
    element.style.height = '20px';
    document.body.append(element);
    const listeners = new Map<string, () => void>();
    const terminal = {
      element,
      geometry: { cols: 30, rows: 1 },
      readViewport: async () => ({
        cols: 30,
        rows: 1,
        dirty: 'clean' as const,
        cursor: {
          x: 0,
          y: 0,
          visible: true,
          blinking: false,
          passwordInput: false,
          wideTail: false,
          style: 'block' as const,
        },
        colors: {
          foreground: { r: 255, g: 255, b: 255 },
          background: { r: 0, g: 0, b: 0 },
          cursor: null,
          palette: [],
        },
        viewportRows: [
          {
            y: 0,
            text: '   https://example.test',
            cells: [...'   https://example.test'].map((text, x) => ({
              x,
              text: text === ' ' ? '' : text,
              width: 'narrow' as const,
              style: {
                bold: false,
                italic: false,
                faint: false,
                blink: false,
                inverse: false,
                invisible: false,
                strikethrough: false,
                overline: false,
                underline: 0,
              },
              foreground: null,
              background: null,
              hyperlink: false,
              semanticContent: 'unknown' as const,
            })),
            wrapped: false,
            wrapContinuation: false,
            selection: null,
          },
        ],
      }),
      on<Key extends keyof BrowserTerminalEventMap>(
        type: Key,
        listener: (value: BrowserTerminalEventMap[Key]) => void
      ): Disposable {
        listeners.set(type, listener as () => void);
        return { dispose: () => listeners.delete(type) };
      },
    } as unknown as BrowserTerminal;
    const activate = vi.fn();
    const addon = new WebLinksAddon({ pattern: /https?:\/\/\S+/i, activate });
    addon.activate(terminal);
    await Promise.resolve();
    await Promise.resolve();
    const link = element.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.tabIndex).toBe(0);
    expect(link?.style.left).toBe('30px');
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(activate).not.toHaveBeenCalled();
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(activate).toHaveBeenCalledOnce();
    listeners.get('viewportChange')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(element.querySelectorAll('a')).toHaveLength(1);
    addon.dispose();
    expect(listeners.size).toBe(0);
    element.remove();
  });

  it('supports cell-free snapshots, unmodified activation, and default navigation', async () => {
    const element = document.createElement('div');
    element.style.width = '300px';
    element.style.height = '20px';
    document.body.append(element);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const terminal = terminalFor(element, async () => viewport('x https://example.test', false));
    const addon = new WebLinksAddon({ requireModifier: false });
    addon.activate(terminal);
    await settle();

    const link = element.querySelector('a');
    expect(link?.getAttribute('aria-label')).toBe('https://example.test');
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(open).toHaveBeenCalledWith('https://example.test', '_blank', 'noopener,noreferrer');

    addon.dispose();
    open.mockRestore();
    element.remove();
  });

  it('keeps the newest refresh, permits touch activation, and ignores late disposed reads', async () => {
    const element = document.createElement('div');
    element.style.width = '300px';
    element.style.height = '20px';
    document.body.append(element);
    const reads: Array<ReturnType<typeof deferred<ViewportSnapshot>>> = [];
    const terminal = terminalFor(element, () => {
      const read = deferred<ViewportSnapshot>();
      reads.push(read);
      return read.promise;
    });
    const activate = vi.fn();
    const addon = new WebLinksAddon({ activate });
    addon.activate(terminal);
    await Promise.resolve();

    const newest = addon.refresh();
    reads[1]?.resolve(viewport('https://new.test'));
    await newest;
    reads[0]?.resolve(viewport('https://old.test'));
    await settle();
    const link = element.querySelector('a');
    expect(link?.href).toContain('https://new.test');

    link?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' })
    );
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(activate).toHaveBeenCalledWith(expect.any(MouseEvent), 'https://new.test');

    const pending = addon.refresh();
    addon.dispose();
    reads[2]?.resolve(viewport('https://late.test'));
    await pending;
    expect(element.querySelector('a')).toBeNull();
    element.remove();
  });

  it('recovers its refresh queue after a viewport read failure', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const listeners = new Map<string, () => void>();
    let attempts = 0;
    const terminal = terminalFor(
      element,
      async () => {
        if (attempts++ === 0) throw new Error('snapshot unavailable');
        return viewport('https://recovered.test');
      },
      listeners
    );
    const addon = new WebLinksAddon();
    addon.activate(terminal);
    await settle();
    listeners.get('writeParsed')?.();
    await settle();
    expect(element.querySelector('a')?.href).toContain('https://recovered.test');
    addon.dispose();
    element.remove();
  });
});

function terminalFor(
  element: HTMLElement,
  readViewport: () => Promise<ViewportSnapshot>,
  listeners = new Map<string, () => void>()
): BrowserTerminal {
  return {
    element,
    geometry: { cols: 30, rows: 1 },
    readViewport,
    on<Key extends keyof BrowserTerminalEventMap>(
      type: Key,
      listener: (value: BrowserTerminalEventMap[Key]) => void
    ): Disposable {
      listeners.set(type, listener as () => void);
      return { dispose: () => listeners.delete(type) };
    },
  } as unknown as BrowserTerminal;
}

function viewport(text: string, includeCells = true): ViewportSnapshot {
  return {
    cols: 30,
    rows: 1,
    dirty: 'clean',
    cursor: {
      x: 0,
      y: 0,
      visible: true,
      blinking: false,
      passwordInput: false,
      wideTail: false,
      style: 'block',
    },
    colors: {
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: null,
      palette: [],
    },
    viewportRows: [
      {
        y: 0,
        text,
        cells: includeCells ? [...text].map((value, x) => renderCell(x, value)) : [],
        wrapped: false,
        wrapContinuation: false,
        selection: null,
      },
    ],
  };
}

function renderCell(x: number, text: string): RenderCell {
  return {
    x,
    text,
    width: 'narrow',
    style: {
      bold: false,
      italic: false,
      faint: false,
      blink: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      overline: false,
      underline: 0,
    },
    foreground: null,
    background: null,
    hyperlink: false,
    semanticContent: 'unknown',
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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

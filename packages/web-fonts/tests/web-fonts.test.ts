import type { BrowserTerminal, TerminalGeometry } from '@gespenst/core';
import { describe, expect, it, vi } from 'vitest';
import { WebFontsAddon } from '../src';

const geometry: TerminalGeometry = {
  cols: 80,
  rows: 24,
  cellWidthPx: 8,
  cellHeightPx: 16,
  widthPx: 640,
  heightPx: 384,
};

describe('@gespenst/web-fonts', () => {
  it('requires activation and releases its terminal on disposal', async () => {
    const addon = new WebFontsAddon();
    await expect(addon.load([])).rejects.toThrow('not active');
    addon.activate(fakeTerminal().terminal);
    addon.dispose();
    await expect(addon.load([])).rejects.toThrow('not active');
  });

  it('loads definitions in order, clones bytes, forwards descriptors, and applies the font', async () => {
    const calls: unknown[] = [];
    const value = fakeTerminal({
      loadFont: vi.fn(async (font) => {
        calls.push(font);
      }),
    });
    const addon = new WebFontsAddon();
    addon.activate(value.terminal);
    const bytes = new Uint8Array([1, 2, 3]).buffer;

    await expect(
      addon.load(
        [
          { family: 'URL Font', source: 'url(font.woff2)', descriptors: { weight: '400' } },
          { family: 'Byte Font', source: bytes },
        ],
        { family: 'Byte Font', sizePx: 16 }
      )
    ).resolves.toBe(geometry);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      family: 'URL Font',
      source: 'url(font.woff2)',
      descriptors: { weight: '400' },
    });
    const byteSource = (calls[1] as { source: ArrayBuffer }).source;
    expect(new Uint8Array(byteSource)).toEqual(new Uint8Array([1, 2, 3]));
    expect(byteSource).not.toBe(bytes);
    expect(value.setFont).toHaveBeenCalledWith({ family: 'Byte Font', sizePx: 16 });
  });

  it('stops at a failed font and does not apply options', async () => {
    const value = fakeTerminal({
      loadFont: vi.fn(async () => {
        throw new Error('font failed');
      }),
    });
    const addon = new WebFontsAddon();
    addon.activate(value.terminal);

    await expect(addon.load([{ family: 'Broken', source: 'url(broken)' }])).rejects.toThrow(
      'font failed'
    );
    expect(value.setFont).not.toHaveBeenCalled();
  });
});

function fakeTerminal(overrides: Partial<BrowserTerminal> = {}) {
  const loadFont = overrides.loadFont ?? vi.fn(async () => undefined);
  const setFont = overrides.setFont ?? vi.fn(async () => geometry);
  return {
    loadFont,
    setFont,
    terminal: { loadFont, setFont, ...overrides } as unknown as BrowserTerminal,
  };
}

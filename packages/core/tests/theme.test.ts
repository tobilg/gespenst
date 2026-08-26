import { describe, expect, it } from 'vitest';
import {
  createCoreRuntime,
  parseTerminalColor,
  resolveTerminalTheme,
  ThemeValidationError,
} from '../src/core';

describe('terminal themes', () => {
  it('parses the portable CSS subset and structured RGBA colors', () => {
    expect(parseTerminalColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseTerminalColor('#11223380')).toEqual({ r: 17, g: 34, b: 51, a: 128 / 255 });
    expect(parseTerminalColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseTerminalColor('rgba(10, 20, 30, 0.25)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseTerminalColor({ r: 1, g: 2, b: 3, a: 0.4 })).toEqual({ r: 1, g: 2, b: 3, a: 0.4 });
    expect(() => parseTerminalColor('rebeccapurple', 'cursor')).toThrow(ThemeValidationError);
  });

  it('resolves named and extended palette precedence', () => {
    const theme = resolveTerminalTheme({
      palette: ['#010203', '#111111', ...Array.from({ length: 15 }, () => '#222222')],
      black: '#abcdef',
      extendedAnsi: ['rgba(9, 8, 7, 0.5)'],
    });
    expect(theme.palette).toHaveLength(256);
    expect(theme.palette[0]).toEqual({ r: 171, g: 205, b: 239, a: 1 });
    expect(theme.palette[16]).toEqual({ r: 9, g: 8, b: 7, a: 0.5 });
  });

  it('uses replacement and patch semantics and reports color scheme changes', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ theme: { foreground: '#123456' } });
    const replies: string[] = [];
    terminal.on('input', ({ data }) => replies.push(new TextDecoder().decode(data)));

    await terminal.setTheme({ appearance: 'light', background: '#ffffff' });
    expect(terminal.theme.foreground).toBeUndefined();
    terminal.write('\x1b[?996n');
    expect(replies.at(-1)).toBe('\x1b[?997;2n');

    await terminal.updateTheme({ foreground: '#101010' });
    expect(terminal.theme.background).toBe('#ffffff');
    expect(terminal.theme.foreground).toBe('#101010');
    expect(terminal.viewport().colors.palette).toHaveLength(256);

    runtime.dispose();
  });
});

import { Terminal as ReferenceTerminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '../../src/index';

const terminals: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

function write(
  terminal: { write(data: string | Uint8Array, callback?: () => void): void },
  data: string
): Promise<void> {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

describe('@gespenst/xterm differential compatibility', () => {
  it('matches xterm.js 6 stable option defaults and normalization', () => {
    const reference = new ReferenceTerminal();
    const terminal = new Terminal();
    terminals.push(reference, terminal);

    const properties = [
      'allowProposedApi',
      'allowTransparency',
      'altClickMovesCursor',
      'convertEol',
      'cursorBlink',
      'cursorInactiveStyle',
      'cursorStyle',
      'cursorWidth',
      'disableStdin',
      'drawBoldTextInBrightColors',
      'fastScrollSensitivity',
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontWeightBold',
      'letterSpacing',
      'lineHeight',
      'minimumContrastRatio',
      'screenReaderMode',
      'scrollback',
      'scrollOnUserInput',
      'scrollSensitivity',
      'smoothScrollDuration',
      'tabStopWidth',
      'wordSeparator',
    ] as const;

    for (const property of properties)
      expect(terminal.options[property], property).toEqual(reference.options[property]);

    reference.options.minimumContrastRatio = 99;
    terminal.options.minimumContrastRatio = 99;
    reference.options.cursorWidth = 2.8;
    terminal.options.cursorWidth = 2.8;
    expect(terminal.options.minimumContrastRatio).toBe(reference.options.minimumContrastRatio);
    expect(terminal.options.cursorWidth).toBe(reference.options.cursorWidth);
  });

  it('matches parsed buffer text, color metadata, modes, and alternate-screen state', async () => {
    const reference = new ReferenceTerminal({ cols: 20, rows: 3, scrollback: 10 });
    const terminal = new Terminal({ cols: 20, rows: 3, scrollback: 10 });
    terminals.push(reference, terminal);

    await Promise.all([
      write(reference, '\x1b[31mred\x1b[0m\tX\r\nsecond\x1b[?2004h'),
      write(terminal, '\x1b[31mred\x1b[0m\tX\r\nsecond\x1b[?2004h'),
    ]);

    for (let line = 0; line < 3; line += 1) {
      expect(terminal.buffer.active.getLine(line)?.translateToString(true), `line ${line}`).toBe(
        reference.buffer.active.getLine(line)?.translateToString(true)
      );
    }
    const expectedCell = reference.buffer.active.getLine(0)?.getCell(0);
    const actualCell = terminal.buffer.active.getLine(0)?.getCell(0);
    expect(actualCell?.getFgColorMode()).toBe(expectedCell?.getFgColorMode());
    expect(actualCell?.getFgColor()).toBe(expectedCell?.getFgColor());
    expect(actualCell?.isFgPalette()).toBe(expectedCell?.isFgPalette());
    expect(terminal.modes.bracketedPasteMode).toBe(reference.modes.bracketedPasteMode);

    await Promise.all([write(reference, '\x1b[?1049hALT'), write(terminal, '\x1b[?1049hALT')]);
    expect(terminal.buffer.active.type).toBe(reference.buffer.active.type);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      reference.buffer.active.getLine(0)?.translateToString(true)
    );

    await Promise.all([write(reference, '\x1b[?1049l'), write(terminal, '\x1b[?1049l')]);
    expect(terminal.buffer.active.type).toBe(reference.buffer.active.type);
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe(
      reference.buffer.active.getLine(1)?.translateToString(true)
    );
  });

  it('matches clear by preserving the cursor line and discarding other history', async () => {
    const reference = new ReferenceTerminal({ cols: 12, rows: 3, scrollback: 10 });
    const terminal = new Terminal({ cols: 12, rows: 3, scrollback: 10 });
    terminals.push(reference, terminal);
    const contents = 'discard\r\nkeep me';
    await Promise.all([write(reference, contents), write(terminal, contents)]);

    reference.clear();
    terminal.clear();
    await Promise.all([write(reference, ''), write(terminal, '')]);

    expect(terminal.buffer.active.baseY).toBe(reference.buffer.active.baseY);
    expect(terminal.buffer.active.viewportY).toBe(reference.buffer.active.viewportY);
    expect(terminal.buffer.active.cursorX).toBe(reference.buffer.active.cursorX);
    expect(terminal.buffer.active.cursorY).toBe(reference.buffer.active.cursorY);
    for (let line = 0; line < 3; line += 1) {
      expect(terminal.buffer.active.getLine(line)?.translateToString(true), `line ${line}`).toBe(
        reference.buffer.active.getLine(line)?.translateToString(true)
      );
    }
  });
});

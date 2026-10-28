import { Terminal as ReferenceTerminal } from '@xterm/xterm';
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '../../src/index';

const terminals: Array<{ dispose(): void }> = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  for (const container of containers.splice(0)) container.remove();
});

function write(
  terminal: { write(data: string | Uint8Array, callback?: () => void): void },
  data: string
): Promise<void> {
  return new Promise<void>((resolve) => terminal.write(data, resolve));
}

const text = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const ZWJ = text(0x200d);

type ObservedTerminal = Pick<ReferenceTerminal, 'buffer' | 'onData' | 'write'>;

interface Observation {
  readonly lines: string[];
  readonly cursorX: number;
  readonly cursorY: number;
  readonly baseY: number;
  readonly replies: string;
}

/** Writes each chunk in order and records the buffer, cursor, and replies sent to the PTY. */
async function observe(
  terminal: ObservedTerminal,
  chunks: readonly string[]
): Promise<Observation> {
  let replies = '';
  const subscription = terminal.onData((value) => {
    replies += value;
  });
  for (const chunk of chunks) await write(terminal, chunk);
  subscription.dispose();
  const buffer = terminal.buffer.active;
  return {
    lines: Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? ''
    ),
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    replies,
  };
}

/** Runs the same output through xterm.js and Gespenst and returns `[xterm, gespenst]`. */
function observeBoth(
  data: string | readonly string[],
  { cols = 20, rows = 3, open = false } = {}
): Promise<[Observation, Observation]> {
  const chunks = typeof data === 'string' ? [data] : data;
  const reference = new ReferenceTerminal({ cols, rows, scrollback: 10 });
  const terminal = new Terminal({ cols, rows, scrollback: 10 });
  terminals.push(reference, terminal);
  if (open) {
    // xterm.js answers color queries only from an attached terminal.
    for (const target of [reference, terminal]) {
      const container = document.createElement('div');
      container.style.width = '400px';
      container.style.height = '200px';
      document.body.append(container);
      containers.push(container);
      target.open(container);
    }
  }
  return Promise.all([observe(reference, chunks), observe(terminal, chunks)]);
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

  // Ghostty 1.4 fixed each of these; the previous vendored build diverged from xterm.js.
  it.each([
    ['ANSI mode reports (DECRQM)', '\x1b[4h\x1b[20h\x1b[4$p\x1b[20$p', {}],
    ['soft reset (DECSTR)', '\x1b[4h\x1b[?6h\x1b[!p\x1b[4$p\x1b[?6$p', {}],
    ['tab stop clearing (TBC)', '\x1b[9G\x1b[gA\r\tB\r\n\x1b[17G\x1b[0g\r\t\tC', { cols: 40 }],
    ['wide and Latin-1 text with DEC special graphics', `\x1b(0q${text(0xe9, 0x6f22)}q\x1b(B`, {}],
    ['a combining mark after the last column', `abcdefgh${text(0x301)}X`, { cols: 8 }],
    [
      'origin mode cursor addressing',
      '\x1b[2;4r\x1b[?6h\x1b[1dA\x1b[10dB\x1b[1;1H\x1b[5eC\x1b[9;9HD',
      { rows: 6 },
    ],
    ['CJK width', `${text(0x6f22, 0x5b57)}|`, {}],
  ])('matches xterm.js for %s', async (_name, data, options) => {
    const [expected, actual] = await observeBoth(data, options);
    expect(actual).toEqual(expected);
  });

  describe('documented differences from xterm.js', () => {
    it('moves the screen into scrollback when a shell prompt clears it', async () => {
      // Ghostty 1.4 treats ED 2 below an OSC 133 prompt as `clear`/ctrl+l and keeps the history.
      // The shell prints its prompt and later answers ctrl+l with a separate write.
      const [expected, actual] = await observeBoth(
        ['out1\r\nout2\r\n\x1b]133;A\x07$ \x1b]133;B\x07', '\x1b[H\x1b[2J'],
        { rows: 4 }
      );
      expect(expected.baseY).toBe(0);
      expect(expected.lines).toEqual(['', '', '', '']);
      expect(actual.baseY).toBe(3);
      expect(actual.lines.slice(0, 3)).toEqual(['out1', 'out2', '$']);

      const plain = await observeBoth('out1\r\nout2\r\n$ \x1b[H\x1b[2J', { rows: 4 });
      expect(plain[1]).toEqual(plain[0]);
    });

    it('restores OSC 4 palette changes on a full reset', async () => {
      const query = '\x1b]4;1;?\x07';
      const [, defaults] = await observeBoth(query, { open: true });
      const [expected, actual] = await observeBoth(`\x1b]4;1;rgb:12/34/56\x07\x1bc${query}`, {
        open: true,
      });
      expect(expected.replies).toContain('rgb:1212/3434/5656');
      expect(actual.replies).toBe(defaults.replies);
      expect(actual.replies).not.toContain('rgb:1212/3434/5656');
    });

    it('reports keyboard action and send/receive modes as changeable', async () => {
      const [expected, actual] = await observeBoth('\x1b[2$p\x1b[12$p');
      expect(expected.replies).toBe('\x1b[2;4$y\x1b[12;3$y');
      expect(actual.replies).toBe('\x1b[2;2$y\x1b[12;1$y');
    });

    it('keeps cursor movement inside left and right margins', async () => {
      // xterm.js does not implement DECLRMM (mode 69) or DECSLRM.
      const margins = '\x1b[?69h\x1b[3;6s';
      const [cubExpected, cubActual] = await observeBoth(`${margins}\x1b[1;5H\x1b[10D`);
      const [bsExpected, bsActual] = await observeBoth(`${margins}\x1b[1;3H\b\b`);
      expect([cubExpected.cursorX, bsExpected.cursorX]).toEqual([0, 0]);
      expect([cubActual.cursorX, bsActual.cursorX]).toEqual([2, 2]);
    });

    it('applies single shifts to the next character only', async () => {
      for (const shift of ['\x1b*0\x1bN', '\x1b+0\x1bO']) {
        const [expected, actual] = await observeBoth(`${shift}qqx`);
        expect(expected.lines[0]).toBe('qqx');
        expect(actual.lines[0]).toBe(`${text(0x2500)}qx`);
      }
    });

    it('measures emoji with Unicode 18 widths and grapheme clustering', async () => {
      const cases: Array<[string, string, number, number]> = [
        ['emoji presentation', `${text(0x231a)}|`, 2, 3],
        ['VS16 with mode 2027', `\x1b[?2027h${text(0x2764, 0xfe0f)}|`, 2, 3],
        ['VS15 with mode 2027', `\x1b[?2027h${text(0x231a, 0xfe0e)}|`, 2, 2],
        [
          'ZWJ sequence with mode 2027',
          `\x1b[?2027h${text(0x1f468)}${ZWJ}${text(0x1f469)}${ZWJ}${text(0x1f467)}|`,
          4,
          3,
        ],
      ];
      for (const [name, data, xtermColumn, gespenstColumn] of cases) {
        const [expected, actual] = await observeBoth(data);
        expect(expected.cursorX, name).toBe(xtermColumn);
        expect(actual.cursorX, name).toBe(gespenstColumn);
      }
    });
  });
});

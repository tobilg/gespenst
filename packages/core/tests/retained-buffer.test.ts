import { describe, expect, it } from 'vitest';
import { type CoreTerminal, createCoreRuntime } from '../src/core';
import { RetainedBuffer } from '../src/internal/retained-buffer.js';
import type { XtermCompatibilityRow } from '../src/internal/xterm-compatibility.js';

describe('retained row changes', () => {
  const filled = 'r1\r\nr2\r\nr3\r\nr4';
  const history = `${filled}\r\nr5\r\nr6\r\nr7\r\nr8`;
  const bottom = '\x1b[4;1H';

  it.each<[string, readonly string[], boolean, readonly string[]]>([
    ['a row written and then scrolled away', [filled], false, [`\x1b[1;1HXX${bottom}\n`]],
    ['a row erased and then scrolled away', [filled], false, [`\x1b[1;1H\x1b[2K${bottom}\n`]],
    ['rows shifted by DL and then scrolled away', [filled], false, [`\x1b[1;1H\x1b[M${bottom}\n`]],
    ['rows inserted by IL', [history], false, ['\x1b[2;1H\x1b[2L']],
    ['a row written and then scrolled up (SU)', [filled], false, ['\x1b[1;1HZZ\x1b[S']],
    ['rows scrolled down (SD)', [history], false, ['\x1b[2T']],
    ['a scroll region', [history], false, ['\x1b[2;3r\x1b[3;1H\n\n\nin region\x1b[r']],
    [
      'a prompt cleared in the same write',
      [],
      false,
      ['out1\r\nout2\r\n\x1b]133;A\x07$ \x1b]133;B\x07\x1b[H\x1b[2J'],
    ],
    ['erased scrollback', [history], false, ['\x1b[3J', 'after\r\nmore']],
    ['an in-place update below a scrolled-back viewport', [history], true, ['\x1b[2;1HUP']],
    [
      'writes below a scrolled-back viewport',
      [history],
      true,
      ['\x1b[2;1HV1', '\x1b[4;1Htail\r\n\r\nnext'],
    ],
  ])('keeps cached rows exact for %s', async (_name, setup, scrolledBack, writes) => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 20, rows: 4, scrollbackLines: 100 });
    const replica = rowCache(terminal);
    for (const data of setup) terminal.write(data);
    replica.sync();
    if (scrolledBack) terminal.scrollLines(-3);
    for (const data of writes) {
      terminal.write(data);
      replica.sync();
    }
    expect(replica.resets).toBe(1);
    runtime.dispose();
  });

  it('follows large unsplit writes while history is pruned', async () => {
    const runtime = await createCoreRuntime();
    // Wide rows make pages small, so history is pruned a page at a time.
    const terminal = runtime.createTerminal({ cols: 300, rows: 6, scrollbackLines: 300 });
    const replica = rowCache(terminal);
    let line = 0;
    const lines = (count: number) =>
      Array.from({ length: count }, () => `\r\nline ${line++}`).join('');
    terminal.write(`seed${lines(40)}`);
    replica.sync();
    terminal.scrollLines(-10);
    let trimmed = 0;
    for (let write = 0; write < 80; write += 1) {
      terminal.write(lines(5 + (write % 17)));
      trimmed += replica.sync().trimmed;
    }
    expect(trimmed).toBeGreaterThan(0);
    expect(replica.resets).toBe(1);

    // A write that prunes the anchor row itself loses row identity.
    terminal.write(lines(2000));
    expect(replica.sync().reset).toBe(true);
    runtime.dispose();
  }, 30_000);

  it('resets after resizes, resets, and restores', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 20, rows: 4, scrollbackLines: 100 });
    const replica = rowCache(terminal);
    terminal.write(history);
    replica.sync();
    const snapshot = terminal.snapshot();
    for (const change of [
      () => terminal.resize(30, 5),
      () => terminal.reset(),
      () => terminal.restore(snapshot),
    ]) {
      change();
      expect(replica.sync().reset).toBe(true);
    }
    terminal.write('x');
    expect(replica.sync().reset).toBe(false);
    runtime.dispose();
  });

  it('measures the normal screen across a full-screen app', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal({ cols: 300, rows: 6, scrollbackLines: 300 });
    const replica = rowCache(terminal);
    let line = 0;
    const lines = (count: number) =>
      Array.from({ length: count }, () => `\r\nline ${line++}`).join('');
    terminal.write(`seed${lines(250)}`);
    replica.sync();

    terminal.write('\x1b[?1049h\x1b[Hfull screen');
    expect(replica.sync()).toMatchObject({ reset: true, state: { screen: 'alternate' } });
    // One write leaves the app, prints enough to prune history, and enters it again.
    terminal.write(`\x1b[?1049l${lines(200)}\x1b[?1049h\x1b[Hagain`);
    replica.sync();
    terminal.write('\x1b[?1049l');
    const back = replica.sync();
    expect(back).toMatchObject({ reset: false, state: { screen: 'normal' } });
    expect(back.trimmed).toBeGreaterThan(0);
    runtime.dispose();
  });
});

describe('retained buffer', () => {
  it.each([47, 1047, 1049])(
    'reads the normal screen from a clone while mode %i is active',
    async (mode) => {
      const runtime = await createCoreRuntime();
      const terminal = runtime.createTerminal({ cols: 20, rows: 4, scrollbackLines: 100 });
      const buffer = new RetainedBuffer(runtime, terminal);
      terminal.write('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix');
      const normalState = buffer.normalState();
      const normalRows = buffer.normalRows(0, normalState.totalRows).map(withoutIndex);

      terminal.write(`\x1b[?${mode}h\x1b[2J\x1b[Hfull screen`);
      expect(buffer.state().screen).toBe('alternate');
      expect(buffer.rows(0, 1).map(withoutIndex)[0]).not.toEqual(normalRows[0]);
      expect(buffer.normalState()).toMatchObject({
        screen: 'normal',
        totalRows: normalState.totalRows,
        scrollbackRows: normalState.scrollbackRows,
      });
      expect(buffer.normalRows(0, normalState.totalRows).map(withoutIndex)).toEqual(normalRows);

      // The clone is dropped on change and on the way back to the normal screen.
      buffer.changed();
      expect(buffer.normalRows(0, normalState.totalRows).map(withoutIndex)).toEqual(normalRows);
      terminal.write(`\x1b[?${mode}l`);
      expect(buffer.normalRows(0, normalState.totalRows).map(withoutIndex)).toEqual(normalRows);
      buffer.dispose();
      runtime.dispose();
    }
  );

  it('notifies listeners until they are disposed', async () => {
    const runtime = await createCoreRuntime();
    const terminal = runtime.createTerminal();
    const buffer = new RetainedBuffer(runtime, terminal);
    let calls = 0;
    const listener = buffer.onChange(() => {
      calls += 1;
    });
    buffer.changed();
    listener.dispose();
    buffer.changed();
    buffer.dispose();
    buffer.changed();
    expect(calls).toBe(1);
    runtime.dispose();
  });
});

/**
 * Caches each screen's rows by index the way the xterm adapter does: applies each change, checks
 * every cached row against a fresh read, then caches all rows again.
 */
function rowCache(terminal: CoreTerminal) {
  type CachedRow = Omit<XtermCompatibilityRow, 'index'> | undefined;
  const caches: Record<string, CachedRow[]> = { normal: [], alternate: [] };
  let resets = 0;
  const read = () =>
    terminal.xtermRows(0, terminal.bufferState().totalRows).map((row) => withoutIndex(row));
  return {
    get resets() {
      return resets;
    },
    sync() {
      const changes = terminal.retainedRowChanges();
      const { screen } = changes.state;
      let cache = caches[screen] ?? [];
      if (changes.reset) {
        resets += 1;
        cache = [];
      } else {
        cache = cache.slice(changes.trimmed, changes.dirtyFrom + changes.trimmed);
      }
      const actual = read();
      expect(actual).toHaveLength(changes.state.totalRows);
      expect(cache.length).toBeLessThanOrEqual(actual.length);
      cache.forEach((row, index) => {
        expect(row, `${screen} row ${index}`).toEqual(actual[index]);
      });
      caches[screen] = actual;
      return changes;
    },
  };
}

function withoutIndex({ index: _index, ...row }: XtermCompatibilityRow) {
  return row;
}

import { createTerminal } from '@gespenst/core';
import { afterEach, describe, expect, it } from 'vitest';
import { SearchAddon } from '../../src';

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  document.body.replaceChildren();
});

describe('@gespenst/search browser compatibility', () => {
  it('searches retained rows and creates one canvas overlay', async () => {
    const host = document.createElement('div');
    host.style.width = '240px';
    host.style.height = '80px';
    document.body.append(host);
    const terminal = await createTerminal({
      container: host,
      worker: false,
      renderer: 'canvas2d',
      cols: 12,
      rows: 2,
      scrollbackLines: 10,
    });
    disposals.push(() => terminal.dispose());
    const search = new SearchAddon({ pageSize: 2 });
    terminal.loadAddon(search);
    await terminal.writeAsync('needle\r\none\r\ntwo\r\nthree');

    expect(await search.findNext('needle')).toBe(true);
    expect(search.getMatch(0)?.start).toEqual({ row: 0, column: 0 });
    expect(terminal.element.querySelectorAll('.gespenst__search-layer')).toHaveLength(1);
  });
});

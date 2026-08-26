# @gespenst/search

Paged full-scrollback search and canvas highlights for
[`@gespenst/core`](https://github.com/tobilg/gespenst).

```ts
import { SearchAddon } from '@gespenst/search';

const search = new SearchAddon();
terminal.loadAddon(search);
const counter = document.querySelector<HTMLElement>('#search-counter')!;

search.onDidChangeResults((result) => {
  if (result.status === 'searching') {
    counter.textContent = 'Searching…';
  } else if (result.status === 'complete') {
    counter.textContent = result.matchCount
      ? `${result.activeIndex + 1} / ${result.matchCount}`
      : 'No matches';
  } else if (result.status === 'error') {
    counter.textContent = result.error;
  }
});

await search.findNext('error', { caseSensitive: false });
```

`findNext()` and `findPrevious()` search the current normal or alternate Ghostty buffer, including
all retained scrollback. They scroll off-screen matches into view, wrap at either end, and resolve
after the active highlight has been painted. Call `clear()` when the search UI closes.

## Results and coordinates

Results use absolute rows measured from the oldest retained row. A match crossing a soft wrap has
one physical-row segment per covered row:

```ts
const match = search.getMatch(0);

match?.start; // { row: 418, column: 76 }
match?.end; // exclusive coordinate on the final row
match?.segments; // [{ row: 418, ... }, { row: 419, ... }]
```

`SearchResult` reports the lifecycle, total count, global active index, and active match without
publishing an accidentally huge array. Use `getMatch(index)` for bounded access to another indexed
match. Absolute row numbers can shift when old scrollback is trimmed; active matches are preserved
internally through Ghostty's stable row identities and refreshed result events carry current
coordinates.

Soft-wrapped rows form one searchable logical line. Explicit line breaks remain boundaries, matching
normal terminal-search behavior. Cell mapping accounts for wide glyphs, emoji, combining text,
tabs, and cursor-created blank columns. `wholeWord` uses Unicode letters, numbers, combining marks,
and connector punctuation as word characters.

## Performance

Search reads bounded pages through `BrowserTerminal.readBuffer()` and releases each page after it is
indexed. Matching yields between main-thread time slices, and the addon uses one device-pixel canvas
instead of one DOM element per match. Only segments intersecting the painted viewport are drawn.

```ts
const search = new SearchAddon({
  pageSize: 256,
  refreshDebounceMs: 150,
});
```

The defaults suit the core package's 10,000-line default scrollback. Reduce `pageSize` when many
main-thread terminals share a page; increase it when worker round trips dominate a very large
history. Terminal writes, resets, restores, reflow, and scrollback changes trigger a debounced
rescan. Scrolling and font changes only redraw the cached visible segments.

## Highlight colors

Set canvas colors through CSS custom properties on the terminal or an ancestor:

```css
.gespenst {
  --gespenst-search-match-background: rgb(255 235 59 / 35%);
  --gespenst-search-active-match-background: rgb(255 179 0 / 55%);
}
```

Invalid regular expressions do not throw from navigation. They return `false` and publish a result
with `status: 'error'` and a readable `error` value. A newer query, `clear()`, or disposal cancels
obsolete paged work.

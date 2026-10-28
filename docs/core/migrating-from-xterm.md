# Migrating from xterm.js

Adopt the native API for new code, or use `@gespenst/xterm` as a compatibility boundary for
an existing xterm.js integration.

## Compatibility-first migration

```sh
pnpm add @gespenst/core @gespenst/xterm
```

```ts
import { Terminal } from '@gespenst/xterm';
import '@gespenst/xterm/css/xterm.css';

const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000 });
terminal.open(document.querySelector<HTMLElement>('#terminal')!);
terminal.onData((data) => socket.send(data));
socket.addEventListener('message', (event) => terminal.write(event.data));
await terminal.ready;
```

The compatibility package exposes the stable xterm.js 6 public TypeScript declarations on top of
the Ghostty-backed native terminal. Synchronous calls made before initialization are queued. Use
`ready` for an explicit initialization boundary and `native` when a gradual migration needs the
underlying `BrowserTerminal`.

### Preload and tune the native runtime

Gespenst-specific constructor controls are isolated under `gespenst`, leaving xterm's current and
future options untouched:

```ts
import { preloadXtermRuntime, Terminal } from '@gespenst/xterm';

const runtime = await preloadXtermRuntime();
const terminal = new Terminal({
  scrollback: 10_000,
  gespenst: {
    ...runtime,
    renderer: 'auto',
  },
});
```

Preloading moves compilation of the VT and callback WASM modules out of terminal startup.
Terminals created with the same WASM sources share one Ghostty runtime.

Like xterm.js, the compatibility package parses output on the main thread, so `buffer` reads are
synchronous. Ghostty parses several hundred MiB/s, and rows are copied out only when `getLine()`
asks for them. There is no `gespenst.worker` option; passing a worker mode throws
`XtermCompatibilityError`. Move a terminal to the native API when its output parsing must run in a
worker. Keep PTY output as `Uint8Array`: write callbacks run after Ghostty has parsed the data,
while `onRender` is the painted-frame boundary.

## Native API mapping

| xterm.js concept | Native equivalent |
| --- | --- |
| `new Terminal()` plus `open()` | `await createTerminal({ container })` |
| `onData()` | `on('input', ({ data }) => ...)` |
| `write(data, callback)` | `write(data)` or `await writeAsync(data)` |
| FitAddon | Built-in `ResizeObserver` and `fit()` |
| WebLinksAddon | `@gespenst/web-links` |
| SearchAddon | `@gespenst/search` |
| SerializeAddon | `@gespenst/serialize` |
| AttachAddon or custom socket wiring | `@gespenst/websocket` or `connect()` |
| `onResize()` | `on('resize', listener)` |
| `buffer.active` | `readBuffer()` and `viewportChange` |

The native `@gespenst/search` addon is asynchronous because it searches Ghostty's complete retained
buffer through bounded pages. It reports absolute, segmented buffer coordinates and can match
across soft wraps. The xterm compatibility package continues to support the official synchronous
`@xterm/addon-search` API for integrations that require its exact result and selection behavior.

The native input event carries bytes, not a JavaScript string. Keep it byte-oriented through the
transport to avoid an encode step and preserve arbitrary terminal protocol data.

The compatibility package reads its normal and alternate `buffer` views from Ghostty on demand,
including retained scrollback, and caches the rows it has read. Ghostty remains the only VT parser;
tracked row references tell the adapter which cached rows moved when history was pruned and which
ones output may have changed. While a full-screen app uses the alternate screen, `buffer.normal`
reads a short-lived copy of the normal screen, created on first use. Like xterm.js,
`buffer.alternate` is blank while the normal screen is active.

## Compatibility limits

The adapter targets the stable xterm.js 6 API. Lifecycle, ordered writes, input, selection, scrolling,
normal and alternate buffers, scrollback, cell attributes, modes, parser handlers, link providers,
markers, and events are covered by browser tests. Differential tests run the same sequences against
xterm.js 6 and compare options, buffer state, color metadata, modes, alternate-screen transitions,
`clear()` behavior, mode reports, soft reset, tab stops, character sets, and origin-mode cursor
addressing. They also pin each [terminal behavior difference](#terminal-behavior-differences).

The following official addon versions are pinned and tested together:

| Addon | Version | Status |
| --- | ---: | --- |
| `@xterm/addon-attach` | 0.12.0 | Supported |
| `@xterm/addon-fit` | 0.11.0 | Supported |
| `@xterm/addon-search` | 0.16.0 | Supported |
| `@xterm/addon-serialize` | 0.14.0 | Supported |
| `@xterm/addon-web-links` | 0.12.0 | Supported |

Proposed APIs require `allowProposedApi`. Features that conflict with Ghostty's shaping and width
model, including custom Unicode width providers and character joiners, throw
`XtermCompatibilityError`. Non-default tab widths, smooth scrolling, ConPTY-specific heuristics,
xterm window manipulation, and xterm's alternative erase/reflow policies also fail explicitly.

Fit and Serialize use a narrow internal adapter for the pinned versions above. General private
`_core` APIs remain outside the contract. Test third-party addons individually and re-run the
compatibility suite before upgrading a pinned official addon.

## Terminal behavior differences

Ghostty is the only VT parser, so `@gespenst/xterm` follows Ghostty where the two emulators
interpret output differently. Programs that rely on the following behavior see different results
than under xterm.js 6:

| Area | xterm.js 6 | Gespenst |
| --- | --- | --- |
| Character widths | Unicode 6 tables; emoji such as ⌚ occupy one cell | Unicode 18 widths; emoji-presentation characters occupy two cells |
| Grapheme clustering (mode 2027) | Ignored; every code point is measured on its own | ZWJ sequences form one two-cell cluster; VS16 widens and VS15 narrows the preceding character |
| `ED 2` while the last non-empty row is an OSC 133 prompt | Erases the screen | Moves the screen into scrollback first, so `clear` and ctrl+l keep history |
| Full reset (`ESC c`) after OSC 4 color changes | Keeps the changed colors | Restores the palette |
| `DECRQM` for KAM (2) and SRM (12) | Reports them as permanently reset and set | Reports their current, changeable state |
| Left and right margins (`DECLRMM`, `DECSLRM`) | Not implemented | Cursor movement such as `CUB` and backspace stops at the left margin |
| Single shifts (`SS2`, `SS3`) | Ignored | Apply the G2 or G3 character set to the next character |
| `scrollback` limit | Keeps exactly that many rows of history | Prunes history a memory page at a time, so it keeps somewhat fewer rows; for example 715 of 1,000 at 120 columns |

ANSI-mode `DECRQM` reports, soft reset (`DECSTR`), tab-stop clearing (`TBC`), and text printed
while DEC special graphics are active match xterm.js.

## Recommended sequence

1. Change imports to `@gespenst/xterm` and get the existing suite green.
2. Replace transport wiring with `@gespenst/websocket` or native byte streams.
3. Replace fit, search, links, and serialization addons with workspace packages.
4. Move new terminal-specific code to `BrowserTerminal` through `native`.
5. Replace the compatibility terminal with `createTerminal()` when no xterm-only surface remains.

## Related API

- {@link @gespenst/xterm!index.Terminal | Terminal}
- {@link @gespenst/xterm!index.XtermCompatibilityError | XtermCompatibilityError}
- {@link @gespenst/core!index.BrowserTerminal | BrowserTerminal}
- {@link @gespenst/core!core.TerminalInputEvent | TerminalInputEvent}

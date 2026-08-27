# @gespenst/core

A high-performance browser terminal and headless VT runtime powered by the official nightly
[`ghostty-vt.wasm`](https://github.com/ghostty-org/ghostty/releases/download/tip/ghostty-vt.wasm).

The native API is byte-oriented and built around Web Streams. Browser terminals use worker
isolation when available, select WebGPU, WebGL2, or Canvas 2D at runtime, and keep application policy
outside the renderer.

> Ghostty's `tip` artifact is a nightly build. Each published package version pins and checksums an
> exact artifact. Pin this package version in production and test upgrades before deployment.

## Install

```sh
pnpm add @gespenst/core
```

## Browser terminal

Import the stylesheet and give the host an explicit height:

```html
<div id="terminal"></div>

<style>
  #terminal {
    width: 100%;
    height: 32rem;
  }
</style>
```

```ts
import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';

const terminal = await createTerminal({
  container: document.querySelector<HTMLElement>('#terminal')!,
  worker: 'dedicated',
  renderer: 'auto',
});

terminal.write('\x1b[1;32mGhostty is ready\x1b[0m\r\n');
terminal.focus();
```

The default worker policy chooses a dedicated worker when `Worker` and `OffscreenCanvas` are
available, with a main-thread retry if worker startup fails. The automatic renderer tries WebGPU,
then WebGL2, then Canvas 2D for cell backgrounds, and moves down that ladder when an accelerated
backend cannot recover at runtime. Browser Canvas 2D shapes text on every renderer path. Releases run
the complete browser suite in Chromium and focused API compatibility tests in Firefox and WebKit;
hardware WebGPU availability is not required because the renderer falls back automatically.

## Connect a PTY

The core accepts bidirectional byte streams and does not impose a server protocol:

```ts
const connection = terminal.connect({
  readable: ptyOutput, // ReadableStream<Uint8Array>
  writable: ptyInput, // WritableStream<Uint8Array>
});

terminal.on('resize', ({ cols, rows }) => {
  sendPtyResize({ cols, rows });
});

await connection.closed;
```

Keep PTY bytes as `Uint8Array` data from the socket to Ghostty. Use
`@gespenst/websocket` for a ready-made binary WebSocket transport with resize messages,
backpressure, and optional reconnect behavior.

## Layout and fonts

The terminal fills its host, so the host must have a nonzero width and height. A `ResizeObserver`
fits the grid to container changes. Call `fit()` after revealing a terminal created in a hidden tab
or dialog.

The default font stack uses installed system monospace fonts. Custom fonts are flexible and do not
come from a predefined list:

```ts
await terminal.loadFont({
  family: 'JetBrains Mono',
  source: 'url(/fonts/jetbrains-mono.woff2)',
  descriptors: { weight: '400 700' },
});

await terminal.setFont({
  family: 'JetBrains Mono, ui-monospace, monospace',
  sizePx: 14,
  lineHeight: 1.25,
});
```

`loadFont()` installs the face in both the document and rendering worker before the grid is
remeasured.

## Themes

Themes use portable CSS strings or RGB(A) objects and include xterm-compatible named ANSI,
selection, and cursor-accent colors. Install `@gespenst/themes` for audited, tree-shakable presets:

```ts
import { catppuccinMocha } from '@gespenst/themes/catppuccin-mocha';

await terminal.setTheme(catppuccinMocha); // replaces the current theme
await terminal.updateTheme({ cursor: '#ffffff' }); // patches it
```

Enable `allowTransparency` at creation when non-selection colors use alpha. Set
`minimumContrastRatio` when automatic text contrast is required. Missing extended ANSI colors are
generated once by Ghostty rather than calculated in the cell-rendering loop.

## Configuration baseline

```ts
const terminal = await createTerminal({
  container,
  worker: 'dedicated',
  renderer: 'auto',
  scrollbackLines: 10_000,
  accessibility: 'basic',
  minimumContrastRatio: 1,
});
```

- Use `worker: 'shared'` when many terminals should share one worker event loop.
- Use `worker: false` for deterministic main-thread execution or unsupported environments.
- Use `accessibility: 'full'` when the product needs a live viewport text mirror.
- Read `terminal.renderer.backend` to see which renderer was actually selected.
- Lower scrollback for many concurrent terminals or memory-constrained devices.

## Application policy

Terminal escape sequences can request clipboard writes and desktop notifications. The core emits
typed `clipboardWrite` and `notification` events but does not perform those browser actions
automatically. Version 0.1.0 denies remote clipboard writes; use `clipboardWrite` only as an audit
record. Validate session trust, user intent, and browser permission before showing notifications.

For user-initiated text and MIME paste, install `@gespenst/clipboard`. It keeps clipboard support
disabled until the addon is loaded, supports Kitty mode-5522 paste events, denies remote writes,
and requires an application confirmation hook before unsafe text can bypass normal paste safety.
See the [clipboard guide](../../docs/core/clipboard.md).

Every `on()` call returns a disposable subscription. Calling `terminal.dispose()` closes active
connections, disposes addons, removes listeners and loaded fonts, releases rendering resources, and
terminates owned workers.

## Buffer and viewport state

Use the paged buffer API for scrollbars, search, links, transcript views, and compatibility layers:

```ts
const visible = await terminal.readBuffer();
const history = await terminal.readBuffer({
  start: 0,
  end: visible.state.totalRows,
});

terminal.on('viewportChange', ({ state: { viewportY, totalRows, viewportLength } }) => {
  updateScrollbar({ viewportY, totalRows, viewportLength });
});
```

Rows are read directly from Ghostty's active grid; Gespenst does not run a second VT parser. Ranges
are half-open and clamped. `viewportY` and the `scroll` event use an absolute zero-based offset from
the oldest retained row. Page only the rows a feature needs on hot paths.

## Headless runtime

```ts
import { createCoreRuntime } from '@gespenst/core/headless';

const runtime = await createCoreRuntime();
const terminal = runtime.createTerminal({ cols: 100, rows: 30 });

terminal.write('\x1b[34mParsed by Ghostty VT\x1b[0m\r\n');
const text = terminal
  .viewport()
  .viewportRows.map((row) => row.text)
  .join('\n');

console.log(text);
runtime.dispose();
```

Reuse one `CoreRuntime` for multiple terminals so they share the compiled Ghostty module. The
headless runtime works without a DOM and exposes resolved cells, dirty rows, cursor state, effects,
selection, snapshots, and input encoding.

## Performance practices

- Keep output byte-native and avoid decode-encode cycles.
- Use `writeAsync()` when a producer needs a parse and render boundary.
- Preserve meaningful transport chunks instead of writing one byte at a time.
- Bound scrollback and avoid frequent viewport or snapshot reads on the output hot path.
- Prefer paged `readBuffer()` ranges over rebuilding all retained scrollback.
- Measure dedicated and shared workers with your real terminal count and output corpus.

The workspace benchmark is intended for controlled comparisons, not a universal throughput claim:

```sh
pnpm bench:throughput
```

## Documentation

- [Core guide](https://github.com/tobilg/gespenst/blob/main/docs/core/index.md)
- [Workspace and package overview](https://github.com/tobilg/gespenst)
- [PTY browser example](https://github.com/tobilg/gespenst/tree/main/examples/pty)

The core guide covers PTY architecture, every configuration group, fonts and themes, event policy,
performance measurement, headless use, xterm.js migration, and troubleshooting.

## License

MIT. The vendored Ghostty WASM is MIT licensed; see `THIRD_PARTY_NOTICES.md`.

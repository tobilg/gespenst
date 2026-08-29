# @gespenst/xterm

The xterm.js 6.0 public API implemented on top of [`@gespenst/core`](https://github.com/tobilg/gespenst).

```sh
pnpm add @gespenst/core @gespenst/xterm
```

```ts
import { Terminal } from '@gespenst/xterm';
import '@gespenst/xterm/css/xterm.css';

const terminal = new Terminal({ scrollback: 10_000 });
terminal.open(document.querySelector('#terminal')!);
terminal.onData((data) => socket.send(data));
socket.onmessage = (event) => terminal.write(event.data);
await terminal.ready;
```

The package ships the xterm.js 6.0 stable public declarations but has no xterm.js runtime dependency.
Initialization is asynchronous internally; calls and writes queue safely, and `ready` plus `native`
expose explicit boundaries.

## Runtime and performance controls

The upstream constructor options stay unchanged. Gespenst-specific controls live under the nested
`gespenst` key so they cannot collide with future xterm.js options:

```ts
import { preloadXtermRuntime, Terminal } from '@gespenst/xterm';

const runtime = await preloadXtermRuntime();
const terminal = new Terminal({
  cols: 120,
  rows: 40,
  scrollback: 10_000,
  gespenst: {
    ...runtime,
    worker: 'shared',
    renderer: 'auto',
  },
});
```

`preloadXtermRuntime()` compiles and caches both WASM modules. Pass its result to one or more
terminals to move compilation out of their startup path. A dedicated worker remains the default;
use `shared` when many simultaneous terminals should share one Ghostty runtime, or `false` for a
controlled main-thread benchmark. `renderer: 'auto'` keeps the WebGPU → WebGL2 → Canvas2D fallback
ladder.

For output, keep PTY data as `Uint8Array` and use write callbacks for flow control. The compatibility
layer completes callbacks after parsing and xterm buffer synchronization, while `onRender` remains
the painted-frame boundary. This matches xterm.js and avoids forcing every small write to wait for a
browser animation frame. Large scrollback writes are internally segmented so the stable xterm
buffer view retains every row without rereading the full Ghostty buffer.

Theme, selection, cursor-accent, extended ANSI, `allowTransparency`, and `minimumContrastRatio`
options are forwarded to the native renderer. Init-only options can be changed before `open()`;
native initialization starts when `open()` is called. Use `toXtermTheme()` when a Gespenst theme
contains structured RGB(A) values that need to be passed to another xterm-compatible consumer.

## Compatibility contract

The following stable xterm.js 6 surfaces are implemented and regression tested:

| Surface | Status |
| --- | --- |
| Lifecycle, writes, input, resize, scrolling, selection, and events | Supported |
| Normal/alternate buffers, scrollback, cell attributes, modes, markers | Supported |
| Runtime options, themes, fonts, cursor options, contrast, accessibility | Supported |
| Parser handlers and link providers | Supported |
| Proposed markers/decorations | Supported when `allowProposedApi` is enabled |
| Character joiners and custom Unicode width providers | Unsupported; throws `XtermCompatibilityError` |
| Non-8-column tab stops, smooth scrolling, ConPTY heuristics, window manipulation | Unsupported; non-default values throw `XtermCompatibilityError` |

`open()` is idempotent, writes may be issued before `open()`, callbacks preserve write order, and
`clear()` follows xterm's cursor-line-preserving behavior. Ghostty is authoritative for parsing,
scrollback, modes, grapheme width, shaping, and rendering.

## Official addon status

These versions are pinned in the compatibility suite and exercised together in a real browser:

| Official addon | Verified version | Status |
| --- | ---: | --- |
| `@xterm/addon-attach` | 0.12.0 | Supported |
| `@xterm/addon-fit` | 0.11.0 | Supported |
| `@xterm/addon-search` | 0.16.0 | Supported |
| `@xterm/addon-serialize` | 0.14.0 | Supported |
| `@xterm/addon-web-links` | 0.12.0 | Supported |

Fit and Serialize currently use a deliberately narrow `_core` adapter matching those pinned addon
versions. General private xterm.js internals are not part of the compatibility contract. Re-test an
official addon before upgrading beyond the versions above; third-party addons are supported only
when they stay on the stable public API.

## Intentional differences

- WASM initialization is asynchronous. Await `ready` only where an explicit startup boundary is
  needed; normal calls can remain synchronous and queue internally.
- `native` exposes the underlying `BrowserTerminal` for gradual migration to Gespenst's byte-oriented
  and lower-overhead API.
- Ghostty owns resize reflow and Unicode width. Compatibility options cannot replace those engines.
- Unsupported non-default options fail explicitly instead of being silently ignored.

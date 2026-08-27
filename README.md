# gespenst

A high-performance TypeScript terminal toolkit powered by the official nightly
[`ghostty-vt.wasm`](https://github.com/ghostty-org/ghostty/releases/download/tip/ghostty-vt.wasm).

The native API is small, byte-oriented, and built around Web Streams. Parsing and rendering run in
a dedicated worker by default, WebGPU/WebGL2 accelerate cell backgrounds, Canvas 2D provides
browser-quality text shaping, and Canvas 2D is also the universal fallback. An optional compatibility
package implements the stable xterm.js 6.0 public API on top.

> Ghostty's `tip` artifact is a nightly build. Published package versions pin and checksum one exact
> artifact; pin your `@gespenst/*` versions in production.

## Documentation

- [Core guide](docs/core/index.md) covers setup, PTY connections, configuration, fonts, events,
  performance, headless use, migration, and troubleshooting.
- [Core package README](packages/core/README.md) is the focused npm-package introduction.
- `pnpm docs:dev` runs the landing page, searchable guides, and complete TypeDoc API reference.

## Packages

| Package | Purpose |
| --- | --- |
| `@gespenst/bashkit` | Portable single-process browser Bash powered by BashKit |
| `@gespenst/core` | Native browser terminal and headless Ghostty runtime |
| `@gespenst/clipboard` | Permission-aware text and MIME clipboard paste |
| `@gespenst/themes` | Curated, tree-shakable light and dark terminal themes |
| `@gespenst/xterm` | xterm.js 6.0 stable public API compatibility |
| `@gespenst/websocket` | Binary WebSocket transport, resize protocol, backpressure, reconnect |
| `@gespenst/search` | Search and viewport highlights |
| `@gespenst/shell` | Stable browser-only Bash facade powered by BashKit |
| `@gespenst/web-links` | Safe HTTP(S) link detection and activation |
| `@gespenst/web-fonts` | Main-thread and worker web-font loading |
| `@gespenst/serialize` | Versioned terminal snapshots with build metadata |
| `@gespenst/react` | React component and hook |
| `@gespenst/vue` | Vue component and composable |
| `@gespenst/svelte` | Svelte action |

All packages use lockstep versions and are ESM-only. CI runs the complete browser suite in Chromium
and focused compatibility suites in Firefox and WebKit. The Canvas 2D path is the portable baseline;
WebGPU and WebGL2 are capability-detected accelerators with automatic fallback. The headless runtime
supports Node.js 20.19+ and Bun.

## Native API

```sh
pnpm add @gespenst/core @gespenst/websocket
```

```ts
import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';
import { WebSocketAddon } from '@gespenst/websocket';

const terminal = await createTerminal({
  container: document.querySelector('#terminal')!,
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  accessibility: 'full',
});

const socket = new WebSocketAddon('wss://example.test/terminal', {
  reconnect: { maxAttempts: 8 },
});
terminal.loadAddon(socket);
await socket.ready;
```

`terminal.geometry` always contains the current grid and device-pixel cell size. The `resize` event
is emitted after the backend has received a changed geometry. Use `resize(cols, rows)` for an
explicit PTY size or `fit()` to measure the container.

For custom backends, connect a byte-oriented Web Streams transport. Incoming chunks are not decoded
or copied to strings, and `writeAsync` provides a parse-completion boundary:

```ts
const connection = terminal.connect({
  readable: ptyOutput, // ReadableStream<Uint8Array>
  writable: ptyInput,  // WritableStream<Uint8Array>
});

await connection.closed;
```

For a shell that runs entirely in the browser, use `@gespenst/shell`. It provides a stable facade
over BashKit's stateful, single-process interpreter and works on static hosting without a PTY
server or browser-isolation headers:

```ts
import { BrowserShellAddon } from '@gespenst/shell';

const shell = new BrowserShellAddon({
  bashkit: {
    bash: {
      cwd: '/home/guest',
      files: { '/home/guest/README.md': 'Browser-only shell\n' },
    },
  },
});
terminal.loadAddon(shell);
const ready = await shell.ready;
console.log(ready.backend);
```

Use `@gespenst/bashkit` directly when an application needs implementation-specific filesystem or
snapshot APIs. The shell is independent of rendering: its session remains active while core moves
from WebGPU to WebGL2 or Canvas 2D after an unrecoverable graphics failure. BashKit is not a Linux
VM and cannot launch arbitrary native or WASI programs; connect `@gespenst/websocket` to a real
server-side PTY when applications need a full operating-system shell.

Dedicated workers are the default. Use `worker: 'shared'` to multiplex several terminals through
one worker, or `worker: false` for a deterministic main-thread fallback. Renderer preferences are
`auto`, `webgpu`, `webgl2`, and `canvas2d`. WebGPU devices and WebGL contexts are rebuilt after loss,
then repainted from the retained Ghostty viewport.

### Addons and fonts

Addons use the deliberately small `activate(terminal)` / `dispose()` contract. The terminal disposes
addons in reverse load order. Fonts loaded through `terminal.loadFont` or `WebFontsAddon` are
installed in both the document and rendering worker before the grid is remeasured.

```ts
import { SearchAddon } from '@gespenst/search';
import { WebFontsAddon } from '@gespenst/web-fonts';

const fonts = new WebFontsAddon();
terminal.loadAddon(fonts);
await fonts.load(
  [{ family: 'My Mono', source: 'url(/fonts/my-mono.woff2)' }],
  { family: 'My Mono' }
);

const search = new SearchAddon();
terminal.loadAddon(search);
search.onDidChangeResults(({ status, activeIndex, matchCount }) => {
  if (status === 'complete') {
    console.log(matchCount ? `${activeIndex + 1} / ${matchCount}` : 'No matches');
  }
});
await search.findNext('error', { caseSensitive: false });
```

The search addon scans the complete retained Ghostty buffer in bounded pages, navigates to
off-screen matches, and understands matches crossing soft-wrapped rows. Highlights use one canvas,
so DOM size does not grow with the number of results.

### Clipboard and MIME paste

Clipboard access is opt-in. The addon handles ordinary text paste and lets mode-5522 applications
request MIME representations such as PNG data through the Kitty clipboard protocol:

```ts
import { ClipboardAddon } from '@gespenst/clipboard';

const clipboard = new ClipboardAddon({
  confirmUnsafePaste: ({ text }) => window.confirm(`Paste?\n\n${text}`),
});
terminal.loadAddon(clipboard);
await clipboard.ready;
```

Remote clipboard writes remain denied. Reads occur only after a native paste event or an explicit
`pasteFromClipboard()` call made during browser user activation. See the
[clipboard guide](./docs/core/clipboard.md) for the security model and limits.

## xterm.js compatibility

```sh
pnpm add @gespenst/core @gespenst/xterm
```

```ts
import { Terminal } from '@gespenst/xterm';
import '@gespenst/xterm/css/xterm.css';

const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000 });
terminal.open(document.querySelector('#terminal')!);
terminal.onData((data) => socket.send(data));
socket.onmessage = (event) => terminal.write(event.data);
await terminal.ready;
```

The package copies the xterm.js 6.0 stable public declarations, so existing TypeScript integrations
can change their import without adding xterm.js at runtime. Initialization is asynchronous under the
hood; synchronous xterm methods queue safely, while `ready` and `native` expose explicit boundaries.
Proposed APIs require `allowProposedApi`. Feasible proposed features are implemented; features that
conflict with Ghostty's own shaping, such as custom Unicode width providers and character joiners,
throw `XtermCompatibilityError`. The compatibility suite verifies the official Attach 0.12, Fit
0.11, Search 0.16, Serialize 0.14, and Web Links 0.12 addons. Fit and Serialize use a narrow internal
adapter for those pinned versions; general private `_core` APIs remain outside the contract. See
[Migrating from xterm.js](./docs/core/migrating-from-xterm.md) for the complete support matrix and
intentional differences.

## Headless runtime

```ts
import { createCoreRuntime, KeyModifiers } from '@gespenst/core/headless';

const runtime = await createCoreRuntime();
const terminal = runtime.createTerminal({ cols: 80, rows: 24 });
terminal.write('\x1b[31mhello from Ghostty\x1b[0m');
console.log(terminal.viewport().viewportRows.map((row) => row.text).join('\n'));
terminal.key({ code: 'KeyC', text: 'c', modifiers: KeyModifiers.control });
runtime.dispose();
```

The runtime reads Ghostty's self-describing ABI and rejects incompatible nightly artifacts before it
creates a terminal. It exposes resolved cells and colors, dirty rows, selection, cursor state,
snapshots, encoded input, and terminal effects without a DOM.

## PTY example

The repository includes a complete local example with a [`node-pty`](https://github.com/microsoft/node-pty)
backend and a browser frontend using the native Gespenst API. From the repository root, run:

```sh
pnpm install
pnpm example:pty
```

Open <http://127.0.0.1:5174/examples/pty/>. The loopback-only server starts one local PTY per browser
connection and serves the Vite frontend from the same process. Binary frames carry unmodified PTY
bytes; JSON control frames negotiate geometry.

Set `HOST`, `PORT`, or `PTY_CWD` to change the bind address, port, or initial shell directory:

```sh
HOST=127.0.0.1 PORT=5174 PTY_CWD=/path/to/project pnpm example:pty
```

See the [example guide](examples/README.md) and [server implementation](examples/pty-server.ts) for
the protocol and source layout. This is a development example, not a production remote-shell
service; exposing it publicly would provide access to a real local shell.

## Development

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm docs:api
pnpm docs:verify
pnpm docs:dev
pnpm test
pnpm test:browser
pnpm test:browser:compat
pnpm test:coverage
pnpm test:published
pnpm security:audit
pnpm build
pnpm test:pack
pnpm bench:throughput
```

The workspace uses pnpm, TypeScript 7, Vite 8, Vitest, and lockstep package versions.
Maintainers should follow the [release guide](docs/releasing.md); publishing uses tested tarballs,
an environment-protected workflow, and npm trusted publishing rather than a long-lived token.

### Validate the packages published on npm

`pnpm test:published` creates an isolated temporary consumer, resolves every public
`@gespenst/*` package from npm at `latest`, rejects workspace links, runs strict bundler and
NodeNext consumer checks, and exercises the packages in desktop and mobile browser profiles. It
also compares the published native and xterm-compatible terminals with the latest upstream
`@xterm/xterm`; timings are diagnostic reports, not release gates.

```sh
pnpm test:published
pnpm test:published -- --selector 0.1.1
pnpm test:published -- --browser chromium,mobile-webkit --keep
pnpm published:dev -- --selector latest
```

Results are written to `test-results/published/<timestamp>/` as JSON and Markdown. The interactive
command serves the same registry-installed consumer locally; add `--host` to test a phone on the
LAN, and stop it as soon as testing is complete because the harness exposes a real local PTY while
it is running. See the [published-package harness guide](harness/published/README.md) for scenario,
browser, and benchmark methodology.

`pnpm test:coverage` runs the Node and Chromium projects together with V8 instrumentation, prints a
combined summary, and writes browsable HTML, LCOV, and JSON reports to `coverage/`. Open
`coverage/index.html` to inspect coverage by package and source file. Coverage reports all shipped
TypeScript sources under `packages/*/src`; generated declarations and workspace tooling are
excluded. CI enforces a staged ratchet: the workspace must remain above 80% statements, 65%
branches, 78% functions, and 82% lines, with higher line and branch floors for adapters and addons.
The package-specific thresholds live beside the coverage configuration in
`vitest.coverage.config.ts`, so raising a floor is an explicit reviewed change.

`pnpm verify:wasm` validates the vendored checksum, build metadata, imports, exports, and ABI schema;
`pnpm update:wasm` fetches and records a newer official nightly.

`pnpm docs:api` generates the complete, searchable TypeDoc reference for every public workspace
package in `apps/docs/public/api`. Documentation validation fails when a public class, interface,
function, property, method, accessor, type alias, enum, or variable is undocumented. TypeDoc's
reflection tool runs in an isolated workspace with its supported TypeScript compiler; package
implementation, declarations, and normal typechecks continue to use TypeScript 7.

The documentation site defaults to the root URL. Set `DOCS_BASE_PATH` when deploying below a
subpath, for example `DOCS_BASE_PATH=/gespenst/ pnpm docs:build`. Tagged releases publish it to
Cloudflare Pages; see the [release guide](docs/releasing.md) for the project and token setup.

## License

MIT. The vendored Ghostty WASM, copied xterm.js public declarations, and documentation-only demo
runtime are disclosed in the repository and package-specific
[third-party notices](THIRD_PARTY_NOTICES.md).

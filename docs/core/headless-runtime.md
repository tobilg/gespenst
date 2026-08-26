# Headless Runtime

Use Ghostty VT parsing, input encoding, events, snapshots, and resolved viewport cells without a
DOM or browser renderer. The headless runtime is the terminal state machine: it does not create a
shell, open a PTY, draw pixels, or measure fonts.

## Install and create a shared runtime

The headless export is included in `@gespenst/core`:

```sh
pnpm add @gespenst/core
```

{@includeCode ../../examples/core/headless.ts#headless}

One `CoreRuntime` owns the Ghostty WASM instance and can create multiple `CoreTerminal` instances.
Reuse a runtime when processing many independent sessions. Disposing the runtime disposes all of its
terminals and prevents further creation.

## Defaults and geometry

Headless terminals default to 80 columns, 24 rows, 9 by 18 device-pixel cells, and 10,000 scrollback
lines. Set explicit cell dimensions when downstream code uses pixel geometry. There is no font
measurement because the runtime does not own a browser canvas.

## Parsing and output

`write()` accepts text or bytes and updates terminal state. Call `render()` afterward to read an
incremental frame containing changed rows, or call `viewport()` to read a complete resolved
viewport. Use changed rows for incremental consumers and full snapshots only where required.

`bufferState()` returns authoritative active-screen, scrollback, viewport, and cursor coordinates.
`readBuffer()` reads a half-open, clamped range from the complete retained Ghostty grid and defaults
to the visible viewport:

```ts
const state = terminal.bufferState();
const recentHistory = terminal.readBuffer({
  start: Math.max(0, state.totalRows - 200),
  end: state.totalRows,
});
```

Rows include stable retained-row identities, grapheme-aware cells, width roles, resolved styles,
wrapping, and semantic content. Page large histories instead of reading the entire scrollback on
every update.

Terminal input methods return encoded PTY bytes and emit an `input` event. Output may also cause
Ghostty to emit replies or metadata events. Subscribe to the events needed by your integration.

## Test command-line output

Assert the resolved screen rather than comparing raw escape sequences. This works well for CLI
snapshot tests, prompts, progress output, cursor behavior, and ANSI styling tests.

{@includeCode ../../examples/core/headless.ts#headless-test}

## Connect a server-side PTY

Pair the runtime with `node-pty` or another PTY implementation. The adapter below deliberately does
not depend on a specific PTY package. PTY output is parsed into changed rows for the client, while
all `input` events, including terminal replies, are sent back to the PTY.

{@includeCode ../../examples/core/headless.ts#headless-pty}

This cell-diff protocol can reduce client work and bandwidth for specialized applications. For a
conventional browser terminal, forwarding the raw PTY byte stream is simpler and moves parsing to
the client.

## Build a custom renderer

A renderer does not need to parse ANSI or VT sequences. Consume the resolved changed rows and
cursor state with WebGPU, WebGL, Canvas, OffscreenCanvas, or a native rendering surface.

{@includeCode ../../examples/core/headless.ts#headless-renderer}

Use `render().changedRows` on the hot path. Reserve `viewport()` for initialization, recovery, or
occasional inspection to avoid rebuilding every visible row unnecessarily.

## Create searchable transcripts

Extract logical terminal content after cursor movement, wrapping, and screen updates have been
applied. This is useful for searchable CI logs, session summaries, accessibility views, and AI
context extraction.

{@includeCode ../../examples/core/headless.ts#headless-index}

The result represents terminal buffer state, not an immutable raw log. Keep the original PTY stream
as well when auditing or exact playback matters.

## Record and replay sessions

Store timestamped PTY chunks and replay them through the same parser used for live sessions. A
player can update only the rows changed by each chunk.

{@includeCode ../../examples/core/headless.ts#headless-replay}

This pattern supports terminal demos, CI failure replays, debugging tools, thumbnails, and
scrubbable timelines.

## Save and restore terminal state

Snapshots serialize Ghostty terminal state and geometry. Use them for checkpoints, refresh
recovery, worker migration, and fast reconnection without replaying an entire recording.

{@includeCode ../../examples/core/headless.ts#headless-snapshot}

A snapshot does not preserve the shell process or PTY. Persist and reconnect those resources
separately.

## Encode input correctly

The runtime tracks active terminal modes, so keys, paste, focus, and pointer input can be encoded for
the current application state. For example, `paste()` honors bracketed-paste mode.

{@includeCode ../../examples/core/headless.ts#headless-input}

An input method both returns its encoded bytes and emits an `input` event. Choose one forwarding
path; forwarding both would send the same input twice.

## Observe terminal metadata

Titles, working directories, progress reports, notifications, bells, clipboard requests, and errors
are available independently of rendering. This supports dashboards, session managers, IDEs, and
background-task notifications.

{@includeCode ../../examples/core/headless.ts#headless-events}

## Host multiple sessions

Create one `CoreTerminal` for each independent session while sharing a single compiled Ghostty WASM
runtime. This fits browser IDEs, multi-pane terminals, CI dashboards, and server-side session
processors.

{@includeCode ../../examples/core/headless.ts#headless-multiple}

Dispose individual terminals as sessions close. Disposing the runtime releases every terminal that
is still active.

## Custom WASM sources

`createCoreRuntime()` accepts URLs, strings, byte arrays, responses, or compiled
`WebAssembly.Module` objects. The loader caches compilation by URL and by reusable `ArrayBuffer`
identity. Preload with `preloadGhostty()` when startup timing needs an explicit boundary.

The callback bridge must match the Ghostty artifact. Deploy and version both assets together.

## Server use

The runtime is useful for snapshot generation, terminal-aware indexing, protocol tests, server-side
VT parsing, and deterministic render-state inspection. It is not a PTY implementation. Use the
operating system or a PTY package to create a shell process and pass bytes between it and the core.

## Related API

- {@link @gespenst/core!core.createCoreRuntime | createCoreRuntime}
- {@link @gespenst/core!core.CoreRuntime | CoreRuntime}
- {@link @gespenst/core!core.CoreTerminal | CoreTerminal}
- {@link @gespenst/core!index.preloadGhostty | preloadGhostty}
- {@link @gespenst/core!core.ViewportSnapshot | ViewportSnapshot}
- {@link @gespenst/core!core.TerminalBufferSnapshot | TerminalBufferSnapshot}

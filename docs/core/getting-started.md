# Getting Started

Create a responsive browser terminal with the default worker and renderer selection.

## Install

```sh
pnpm add @gespenst/core
```

The terminal needs its package stylesheet and a host element with a nonzero width and height.

```html
<div id="terminal"></div>

<style>
  #terminal {
    width: 100%;
    height: 32rem;
  }
</style>
```

## Create the terminal

This example is compiled by the workspace typecheck and included here from its canonical source.

{@includeCode ../../examples/core/basic.ts#setup}

`createTerminal()` waits until Ghostty WASM, the selected execution context, and the renderer are
ready. The returned terminal owns its DOM nodes, worker, renderer, listeners, addons, and active
connections.

The default `worker` policy uses a dedicated worker when the browser supports workers and
`OffscreenCanvas`. Otherwise, the same API runs on the main thread. The default `renderer: 'auto'`
tries WebGPU, then WebGL2, then Canvas 2D for cell backgrounds. Text shaping always uses the browser
Canvas 2D implementation.

## Container sizing

The package CSS makes the terminal fill its host. It cannot invent a height for the host. A missing
height usually produces a zero-row or unexpectedly small terminal.

The terminal watches its own root with `ResizeObserver`. When its host changes size, the grid is
remeasured and a `resize` event is emitted after the backend receives the new geometry. If the host
is initially hidden, call `terminal.fit()` after it becomes visible.

## Write output and clean up

Use `write()` for fire-and-forget output. Use `writeAsync()` when a producer needs to wait until that
chunk has crossed the parse and render boundary. Keep PTY output as `Uint8Array` data whenever
possible.

Call `dispose()` when the view is removed. Disposal closes connections, disposes addons in reverse
activation order, releases loaded font faces, terminates owned workers, and removes terminal DOM.

## Next

Attach a shell in [Connecting a PTY](./connecting-a-pty.md), or review worker and renderer choices in
[Configuration](./configuration.md).

## Related API

- {@link @gespenst/core!index.createTerminal | createTerminal}
- {@link @gespenst/core!index.GespenstTerminal | GespenstTerminal}
- {@link @gespenst/core!index.TerminalOptions | TerminalOptions}
- {@link @gespenst/core!index.BrowserTerminal#writeAsync | BrowserTerminal.writeAsync}

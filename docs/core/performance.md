# Performance

Preserve the byte-native path first, then measure the complete interaction under representative
output.

## Fast-path practices

1. Keep PTY and WebSocket output as `Uint8Array` chunks. Avoid decoding to strings and encoding it
   again before calling `write()` or `connect()`.
2. Let `connect()` sequence incoming chunks with `writeAsync()` instead of building an unbounded
   application queue.
3. Keep meaningful transport chunks intact. Per-byte writes multiply messages and promises, while
   very large application buffers delay cancellation and feedback.
4. Start with `worker: 'dedicated'` and `renderer: 'auto'`. Change them after profiling your target
   browsers and terminal count.
5. Bound scrollback for the product need. The default is 10,000 lines.
6. Avoid frequent `readViewport()`, full-buffer reads, snapshots, or full accessibility mirroring
   on a hot output path unless the feature requires them. Use narrow `readBuffer()` pages for
   scrollback consumers.
7. Reuse a headless `CoreRuntime` for multiple terminals so they share the compiled WASM module.

Worker writes copy each input chunk into transferable storage so application-owned buffers remain
safe to reuse. This is predictable, but it means avoid producing avoidable intermediate copies
before the terminal boundary.

## `write()` or `writeAsync()`

`write()` queues work and returns immediately. It is appropriate when an upstream transport already
has a bounded queue and no parse boundary is needed.

`writeAsync()` resolves after the chunk has been parsed and rendered. It is the safer primitive for
flow control, tests, ordered snapshots, and producers that must not outpace the terminal.

## Measure the right workload

The repository includes a headless parse/render throughput benchmark:

```sh
pnpm bench:throughput
```

It runs warmups and multiple measured samples, then reports the median. Use it for controlled
comparisons on the same machine, runtime, WASM artifact, input fixture, and power state. Do not use a
single local result as a universal browser throughput claim.

For browser decisions, measure separately:

- time from receiving a PTY chunk to the next painted frame;
- main-thread input responsiveness while output is busy;
- worker message volume and chunk distribution;
- memory growth under realistic scrollback;
- resize, font-load, and tab-visibility transitions;
- the actual renderer reported by `terminal.renderer.backend`.

Record browser version, hardware, device pixel ratio, terminal geometry, worker policy, renderer,
accessibility mode, scrollback limit, font, and output corpus with every result.

## Many terminals

`worker: 'shared'` reduces worker count by multiplexing sessions. Compare it with dedicated workers
using the product's mix of active and idle terminals. Shared execution can lower fixed overhead but
also lets one busy session contend with its neighbors.

Lazy-create terminals that are visible or imminently needed. Dispose hidden sessions that the
product does not intend to preserve, or snapshot them before disposal when restoration is cheaper
than keeping them live.

## Related API

- {@link @gespenst/core!index.BrowserTerminal#write | BrowserTerminal.write}
- {@link @gespenst/core!index.BrowserTerminal#writeAsync | BrowserTerminal.writeAsync}
- {@link @gespenst/core!index.BrowserTerminal#readViewport | BrowserTerminal.readViewport}
- {@link @gespenst/core!index.BrowserTerminal#readBuffer | BrowserTerminal.readBuffer}
- {@link @gespenst/core!index.RendererInfo | RendererInfo}
- {@link @gespenst/core!core.CoreRuntime | CoreRuntime}

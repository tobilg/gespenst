# Troubleshooting

Start with the first visible symptom, then verify the asset, layout, font, and transport boundaries.

## WebAssembly reports an invalid magic word

An error containing bytes such as `3c 21 64 6f` means the browser received HTML beginning with
`<!do` instead of a WASM module. The usual cause is a missing asset rewritten to the application's
HTML fallback.

- Open the WASM request in browser developer tools and verify a successful response.
- Confirm the body begins with the WebAssembly magic bytes, not HTML.
- Serve the asset as `application/wasm` when possible. The loader can fall back to buffered
  compilation for other MIME types, but it cannot compile an HTML response.
- Prefer the package-derived default URL. If you provide `wasm`, make the URL absolute or resolve it
  from `import.meta.url` before passing it across a worker boundary.

## A worker fails to start or reload

The browser worker needs a cloneable WASM source. Pass a string URL, `URL`, bytes, or compiled module
supported by the API. The terminal converts `URL` values to strings before worker messaging.

During development, stale Vite workers can survive a hot update long enough to reference replaced
modules. Reload the page after worker-module changes. Use `worker: false` briefly to isolate whether
the failure is worker setup or the underlying WASM/runtime.

## The terminal has no rows or is unexpectedly small

Give the host a nonzero height. The terminal fills its host with `width: 100%` and `height: 100%`.
Percentage heights require a sized ancestor.

If the terminal was created inside a hidden tab, dialog, or collapsed panel, call `fit()` after the
panel is visible.

## Text, cursor, or spacing looks wrong

- Use a real monospaced font and load it before final geometry is measured.
- Load the same face through `loadFont()` so the document and worker share it.
- Avoid CSS transforms on the host or terminal canvas.
- Confirm normal and bold weights exist and that letter spacing is intentional.
- Call `fit()` after fonts load or device pixel ratio changes.

## Prompt symbols are missing

The default system monospace stack does not promise Nerd Font or private-use glyph coverage. Load a
font containing the prompt symbols. The common Powerline separators have a geometric fallback, but
other icons still depend on font coverage.

## Each newline starts at the previous cursor column

The terminal received line feed without carriage return. A configured operating-system PTY normally
applies output processing. Raw process pipes and some browser process adapters do not. Use a PTY or
apply the adapter's documented line discipline rather than changing renderer behavior.

## Input works but the shell never resizes

Send `terminal.geometry` when the session opens and subscribe to `resize`. Forward `cols` and `rows`
as a control message that your PTY backend validates and applies.

## Rendering is slower than expected

Read `terminal.renderer.backend` rather than assuming WebGPU was selected. Check output chunk sizes,
string conversion, scrollback, full accessibility mirroring, snapshot frequency, and main-thread
work. Compare configurations with the same workload and browser conditions.

See [Performance](./performance.md) for a measurement checklist.

## Related API

- {@link @gespenst/core!index.preloadGhostty | preloadGhostty}
- {@link @gespenst/core!index.BrowserTerminal#fit | BrowserTerminal.fit}
- {@link @gespenst/core!index.BrowserTerminal#loadFont | BrowserTerminal.loadFont}
- {@link @gespenst/core!index.RendererInfo | RendererInfo}

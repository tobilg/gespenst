# Configuration

Choose settings based on the host application, terminal count, and accessibility requirements.

## A practical baseline

```ts
const terminal = await createTerminal({
  container,
  worker: 'dedicated',
  renderer: 'auto',
  scrollbackLines: 10_000,
  accessibility: 'basic',
});
```

These values match the default behavior, so omit them unless being explicit helps your integration.

## Worker policy

| Value | Behavior | Good fit |
| --- | --- | --- |
| `true` or `'dedicated'` | One worker per terminal when supported | One terminal or strong session isolation |
| `'shared'` | Multiple terminal sessions multiplexed through one worker | Terminal-heavy views where worker count matters |
| `false` | Parse and render on the main thread | Tests, constrained embeds, or unsupported worker environments |

The default behaves like `'dedicated'` when `Worker` and `OffscreenCanvas` are available. If that
worker fails before the terminal becomes ready, core recreates its transferred canvases and retries
on the main thread. Shared-worker startup remains strict because silently leaving the shared runtime
would violate the requested ownership model. Live worker crashes remain terminal errors.

## Renderer policy

`'auto'` is the recommended default. It attempts WebGPU, then WebGL2, then Canvas 2D. At runtime,
WebGPU gets one immediate device-restoration attempt and WebGL2 gets a one-second context-restoration
window before core moves down that same ladder. Fallback is monotonic for the lifetime of the
terminal. An explicit `'webgpu'` request remains strict; an explicit `'webgl2'` request may use
Canvas 2D. `terminal.renderer` is live, and the `renderer` event reports successful restoration or
fallback.

The GPU backends accelerate cell backgrounds and decorations. Browser Canvas 2D still shapes text,
which preserves web-font flexibility and avoids a separate glyph atlas contract. Core keeps one
small inactive background surface for each remaining fallback candidate, but sizes and paints only
the active one at terminal resolution.

## Grid and scrollback

Browser terminals measure their grid from the container unless `cols` and `rows` are supplied. With
a fixed grid, automatic observer-driven resize keeps that grid size. Calling `fit()` explicitly
remeasures the host even when initial dimensions were configured.

The default scrollback limit is 10,000 lines. Lower it for many concurrent terminals or memory-tight
devices. Increase it only when the product requires more history and after measuring memory and
viewport operations with representative output.

`cellWidthPx` and `cellHeightPx` are useful for headless terminals. Browser cell size is derived from
the active font, line height, letter spacing, and device pixel ratio.

## Accessibility

| Value | Behavior |
| --- | --- |
| `'off'` | No viewport mirror |
| `'basic'` | Accessible terminal/input semantics without a mirrored viewport |
| `'full'` | Adds a live viewport text mirror for assistive technology |

`'basic'` is the default. Full accessibility transfers and updates visible text from the worker, so
test its cost with realistic output. Use `'full'` when the product requires the live text mirror.

## Transparency and contrast

`allowTransparency` is `false` by default and must be chosen before renderer initialization. When
enabled, Canvas2D, WebGL2, and WebGPU all preserve theme alpha. `minimumContrastRatio` defaults to
`1`; increase it when the product needs automatic foreground adjustment. See
[Theming](./theming.md) for examples and constraints.

## WASM sources

Most bundlers, including Vite, can use the package-derived default WASM URLs without configuration.
Provide `wasm` and `callbacksWasm` only when assets are self-hosted, embedded as bytes, precompiled,
or served from a custom path.

Pin and cache the two compatible artifacts together. The package validates Ghostty's self-described
ABI before creating a runtime.

## Related API

- {@link @gespenst/core!index.TerminalOptions | TerminalOptions}
- {@link @gespenst/core!index.RendererPreference | RendererPreference}
- {@link @gespenst/core!index.RendererInfo | RendererInfo}
- {@link @gespenst/core!core.CoreTerminalOptions | CoreTerminalOptions}

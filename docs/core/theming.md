# Theming

Gespenst themes use a flat, xterm-compatible shape. Colors may be portable CSS strings or
structured RGB and RGBA objects. Theme values are normalized once when applied, outside the render
loop.

## Start with a curated theme

Install the optional catalog and import only the theme you use:

```sh
pnpm add @gespenst/core @gespenst/themes
```

```ts
import { createTerminal } from '@gespenst/core';
import { catppuccinMocha } from '@gespenst/themes/catppuccin-mocha';

const terminal = await createTerminal({
  container,
  theme: catppuccinMocha,
});
```

The package root exports all themes plus the typed `themes` and `themeMetadata` registries for
theme pickers. Subpath imports provide the clearest tree-shaking boundary.

## Create and extend themes

```ts
import type { TerminalTheme } from '@gespenst/core';
import { dracula } from '@gespenst/themes/dracula';

const productTheme = {
  ...dracula,
  background: '#181920',
  cursor: { r: 255, g: 210, b: 90 },
  selectionBackground: 'rgba(98, 114, 164, 0.42)',
} satisfies TerminalTheme;
```

Portable strings support `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, and `rgba()` in browser,
worker, and headless runtimes. Structured RGBA objects use an `a` value from `0` through `1`.

Use the named ANSI properties from `black` through `brightWhite`. Ghostty generates missing colors
16–255 perceptually from those base colors. `extendedAnsi` overrides indices 16–255. The old
positional `palette` property remains available for migration, but named properties take precedence
for indices 0–15 and `extendedAnsi` takes precedence for later indices.

## Switch themes at runtime

`setTheme()` replaces the previous theme and fills omitted values from `DEFAULT_THEME`:

```ts
await terminal.setTheme(dracula);
```

Use `updateTheme()` for a deliberate patch:

```ts
await terminal.updateTheme({ cursor: '#ffffff' });
```

Both promises settle after the local or worker renderer has painted the change. Rapid changes are
coalesced into the pending frame. Theme changes update Ghostty defaults without discarding colors an
application changed through OSC; resetting the OSC color returns to the newest theme default.

## Transparency and contrast

Transparency changes canvas and GPU context creation, so enable it when creating the terminal:

```ts
const terminal = await createTerminal({
  container,
  allowTransparency: true,
  minimumContrastRatio: 4.5,
  theme: {
    background: 'rgba(20, 22, 28, 0.72)',
    foreground: '#f5f7ff',
    selectionBackground: 'rgba(120, 150, 255, 0.35)',
  },
});
```

Without `allowTransparency`, foreground, background, cursor, and palette colors must be opaque;
selection overlays may still be translucent. `minimumContrastRatio` defaults to `1`, meaning no
adjustment. Higher values use a bounded color cache rather than performing contrast calculations for
every cell.

The terminal mirrors resolved colors through `--gespenst-terminal-background`,
`--gespenst-terminal-foreground`, `--gespenst-terminal-cursor`, and
`--gespenst-terminal-selection-background`. They are intended for surrounding UI; the TypeScript
theme remains the canvas rendering source of truth.

## xterm.js compatibility

`@gespenst/xterm` accepts xterm's complete `ITheme`, including selection colors, `cursorAccent`, and
`extendedAnsi`. Set `allowTransparency` before `open()`, as with xterm.js. Scrollbar and overview
ruler theme values are retained in `terminal.options.theme` but do not render because Gespenst does
not currently provide those UI components.

Structured Gespenst colors can be converted for other xterm-compatible consumers:

```ts
import { toXtermTheme } from '@gespenst/xterm';

const compatibleTheme = toXtermTheme(productTheme);
```

## Related API

- {@link @gespenst/core!core.TerminalTheme | TerminalTheme}
- {@link @gespenst/core!core.TerminalColor | TerminalColor}
- {@link @gespenst/core!index.BrowserTerminal#setTheme | BrowserTerminal.setTheme}
- {@link @gespenst/core!index.BrowserTerminal#updateTheme | BrowserTerminal.updateTheme}
- {@link @gespenst/themes!index.themes | themes}
- {@link @gespenst/xterm!index.toXtermTheme | toXtermTheme}

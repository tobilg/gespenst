# Layout, Fonts, and Themes

Keep terminal cells aligned by making layout and font loading explicit.

## Configure appearance

{@includeCode ../../examples/core/customization.ts#appearance}

The default font stack is `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`, with a 14 CSS
pixel size, `1.25` line height, normal weight `400`, bold weight `700`, and no extra letter spacing.
It works without a predefined font list. The browser selects the first installed face in the CSS
stack.

## Load custom fonts before relying on their metrics

`loadFont()` installs a `FontFace` into the document and the active rendering worker. Follow it with
`setFont()` to select the family and trigger a measured fit. Raw `ArrayBuffer` font data can avoid a
second URL fetch and is transferable to the worker.

If a font is declared only in page CSS, the worker may not have access to the same face. Use
`loadFont()` or `@gespenst/web-fonts` for deterministic document and worker loading.

Powerline separators in the common private-use range have a built-in geometric fallback. Other
prompt icons, Nerd Font glyphs, and scripts still require a font that contains those characters.

## Fit behavior

The terminal measures the width of `M`, then derives the device-pixel cell and backing surface from
the host size and device pixel ratio. Font size, line height, weight, and letter spacing all affect
geometry.

Subscribe to `resize` and update the PTY whenever font or container changes alter columns or rows.
The separate `font` event reports the geometry produced by `setFont()`.

Avoid CSS transforms on the terminal host. They visually scale canvases without changing terminal
metrics and can make the cursor or text appear misaligned. Size the host with normal layout instead.

## Themes

Themes accept portable CSS colors, RGB(A) objects, named ANSI colors, selection colors, and live
replacement or patch updates. See the dedicated [Theming guide](./theming.md) for the catalog,
transparency, contrast, palette precedence, and xterm.js compatibility.

## Font troubleshooting checklist

- Confirm the actual font file contains the prompt glyphs you use.
- Load normal and bold weights, or point both terminal weights at available faces.
- Wait for `loadFont()` or `document.fonts.ready` before capturing geometry.
- Call `fit()` after revealing a terminal created in a hidden tab or dialog.
- Avoid proportional fonts, synthetic letter spacing, and host transforms.

## Related API

- {@link @gespenst/core!index.TerminalFontFace | TerminalFontFace}
- {@link @gespenst/core!index.TerminalFontOptions | TerminalFontOptions}
- {@link @gespenst/core!core.TerminalTheme | TerminalTheme}
- {@link @gespenst/core!index.BrowserTerminal#setFont | BrowserTerminal.setFont}
- {@link @gespenst/core!index.BrowserTerminal#fit | BrowserTerminal.fit}

---
title: Core Guide
children:
  Getting Started: ./getting-started.md
  Connecting a PTY: ./connecting-a-pty.md
  Browser-only Shells: ./browser-shells.md
  Configuration: ./configuration.md
  Layout, Fonts, and Themes: ./layout-fonts-themes.md
  Theming: ./theming.md
  Events, Permissions, and Lifecycle: ./events-permissions-lifecycle.md
  Clipboard and MIME Paste: ./clipboard.md
  Performance: ./performance.md
  Headless Runtime: ./headless-runtime.md
  Migrating from xterm.js: ./migrating-from-xterm.md
  Troubleshooting: ./troubleshooting.md
---

# Core Guide

Build a fast browser terminal with the native `@gespenst/core` API. The guide starts with a
rendered terminal, then covers PTY transport, sizing, fonts, application policy, and performance.

## Choose a path

| Goal | Start here |
| --- | --- |
| Render a terminal in a web application | [Getting Started](./getting-started.md) |
| Attach a remote shell or local PTY | [Connecting a PTY](./connecting-a-pty.md) |
| Run Bash entirely in the browser | [Browser-only Shells](./browser-shells.md) |
| Tune workers, rendering, scrollback, or accessibility | [Configuration](./configuration.md) |
| Make fonts, sizing, and themes predictable | [Layout, Fonts, and Themes](./layout-fonts-themes.md) |
| Customize colors, transparency, and ANSI palettes | [Theming](./theming.md) |
| Enable secure text, image, or rich-content paste | [Clipboard and MIME Paste](./clipboard.md) |
| Run Ghostty VT without a DOM | [Headless Runtime](./headless-runtime.md) |
| Move an xterm.js integration | [Migrating from xterm.js](./migrating-from-xterm.md) |

The native API is byte-oriented. PTY output stays as `Uint8Array` data until Ghostty parses it, and
terminal input is exposed in the same form. This keeps transport policy outside the renderer and
avoids unnecessary text conversion on the hot path.

## Package boundaries

Use `@gespenst/core` for the browser terminal and `@gespenst/core/headless` for the
DOM-free runtime. Optional packages add WebSocket transport, portable browser-only shells,
framework bindings, search, serialization, clipboard access, fonts, links, and xterm.js
compatibility.

The package vendors a checksummed Ghostty nightly WASM artifact. Pin package versions in production
so a dependency update and a Ghostty engine update happen together and can be tested together.

## Related API

- {@link @gespenst/core!index.createTerminal | createTerminal}
- {@link @gespenst/core!index.BrowserTerminal | BrowserTerminal}
- {@link @gespenst/core!index.TerminalOptions | TerminalOptions}
- {@link @gespenst/core!core.createCoreRuntime | createCoreRuntime}

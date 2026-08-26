# gespenst API

The complete TypeScript API reference for the Ghostty-powered terminal workspace. Start with
`@gespenst/core` for the native browser and headless APIs, or use
`@gespenst/xterm` when an integration expects the xterm.js 6 public API.

For task-oriented documentation, open the [Core Guide](../core/index.md). Its examples are included
from TypeScript files that are checked with the rest of the workspace.

## Packages

| Package | Purpose |
| --- | --- |
| `@gespenst/core` | Browser terminal, headless VT runtime, rendering, input, and transports |
| `@gespenst/clipboard` | Permission-aware text and MIME clipboard paste |
| `@gespenst/themes` | Curated, tree-shakable terminal themes and metadata |
| `@gespenst/xterm` | xterm.js 6 compatibility layer backed by the native core |
| `@gespenst/websocket` | Binary WebSocket transport with resize and reconnect support |
| `@gespenst/wasmer` | Browser-only WASIX shells powered by Wasmer packages |
| `@gespenst/search` | Paged full-scrollback search, navigation, and canvas highlights |
| `@gespenst/serialize` | Versioned terminal snapshots |
| `@gespenst/web-links` | Safe web-link detection and activation |
| `@gespenst/web-fonts` | Worker-safe web-font loading |
| `@gespenst/react` | React component and hook |
| `@gespenst/vue` | Vue component and composable |
| `@gespenst/svelte` | Svelte action |

Every page is generated directly from the packages' exported TypeScript declarations. Use the
package navigation or full-text search to find a symbol.

## Install

```sh
pnpm add @gespenst/core
```

```ts
import { createTerminal } from '@gespenst/core';

const terminal = await createTerminal({
  container: document.querySelector<HTMLElement>('#terminal')!,
  worker: 'dedicated',
});
```

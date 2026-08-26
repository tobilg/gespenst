# `@gespenst/themes`

Curated, tree-shakable themes for `@gespenst/core` and `@gespenst/xterm`.

```ts
import { createTerminal } from '@gespenst/core';
import { catppuccinMocha } from '@gespenst/themes/catppuccin-mocha';

const terminal = await createTerminal({ container, theme: catppuccinMocha });
await terminal.updateTheme({ cursor: '#ffffff' });
```

Use named exports from `@gespenst/themes` when you need the complete registry, or a package subpath
when an application only needs one theme. Every exported object is frozen; customize one with an
object spread instead of mutating it.

```ts
import { dracula } from '@gespenst/themes/dracula';

const custom = { ...dracula, background: '#181920' };
```

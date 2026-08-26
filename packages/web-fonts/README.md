# @gespenst/web-fonts

Worker-safe font loading for [`@gespenst/core`](https://github.com/tobilg/gespenst).

```ts
import { WebFontsAddon } from '@gespenst/web-fonts';

const fonts = new WebFontsAddon();
terminal.loadAddon(fonts);
await fonts.load([{ family: 'My Mono', source: 'url(/my-mono.woff2)' }], {
  family: 'My Mono',
});
```

Fonts are loaded in the document and rendering worker before the terminal grid is remeasured.

# @gespenst/web-links

Safe HTTP(S) link detection for [`@gespenst/core`](https://github.com/tobilg/gespenst).

```ts
import { WebLinksAddon } from '@gespenst/web-links';

terminal.loadAddon(new WebLinksAddon({ requireModifier: true }));
```

Mouse and pen links require Ctrl-click or Command-click by default and open with
`noopener,noreferrer`. Keyboard, assistive-technology, and touch activation remains available
without a modifier. Supply an `activate` callback when the application should own navigation
policy.

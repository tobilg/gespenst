# @gespenst/react

React bindings for [`@gespenst/core`](https://github.com/tobilg/gespenst).

```sh
pnpm add @gespenst/core @gespenst/react
```

```tsx
import { GespenstTerminal } from '@gespenst/react';
import '@gespenst/core/style.css';

export function Shell() {
  return <GespenstTerminal onReady={(terminal) => terminal.focus()} />;
}
```

The component owns terminal creation and disposal. Initialization option changes recreate the terminal;
use the terminal returned by `onReady` for runtime writes, transport connections, fonts, and themes.

# @gespenst/svelte

A Svelte action for [`@gespenst/core`](https://github.com/tobilg/gespenst).

```svelte
<script lang="ts">
  import { gespenstTerminal } from '@gespenst/svelte';
  import '@gespenst/core/style.css';
</script>

<div use:gespenstTerminal={{ onReady: (terminal) => terminal.focus() }} />
```

The action creates the terminal on mount, supports runtime font and theme updates, and disposes on destroy.

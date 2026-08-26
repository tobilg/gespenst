# @gespenst/vue

Vue bindings for [`@gespenst/core`](https://github.com/tobilg/gespenst).

```vue
<script setup lang="ts">
import { GespenstTerminal } from '@gespenst/vue';
import '@gespenst/core/style.css';
</script>

<template><GespenstTerminal @ready="terminal => terminal.focus()" /></template>
```

The package exports both `GespenstTerminal` and the `useGespenstTerminal` composable.

# @gespenst/serialize

Versioned terminal snapshots for [`@gespenst/core`](https://github.com/tobilg/gespenst).

```ts
import { SerializeAddon } from '@gespenst/serialize';

const snapshots = new SerializeAddon();
terminal.loadAddon(snapshots);
const bytes = await snapshots.serialize();
await snapshots.restore(bytes);
```

The envelope records the Ghostty build checksum and ABI schema so incompatible snapshots fail clearly.

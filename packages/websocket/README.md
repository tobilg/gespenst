# @gespenst/websocket

A binary WebSocket transport for [`@gespenst/core`](https://github.com/tobilg/gespenst).

```ts
import { WebSocketAddon } from '@gespenst/websocket';

const socket = new WebSocketAddon('wss://example.test/terminal', {
  reconnect: { maxAttempts: 8 },
});
terminal.loadAddon(socket);
await socket.ready;
```

The `gespenst.v1` subprotocol sends PTY bytes as binary frames and hello, resize, exit, and
error messages as JSON control frames. See the repository's loopback PTY example for a server.

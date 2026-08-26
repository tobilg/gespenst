# Examples

## Local PTY terminal

Start the TypeScript PTY server and Vite-powered browser client:

```sh
pnpm example:pty
```

Open <http://127.0.0.1:5174/examples/pty/>. Each browser connection starts a shell in a new
pseudoterminal. The browser uses `@gespenst/websocket`; binary WebSocket frames carry
terminal bytes, while text frames carry the versioned hello and resize control messages.

The example binds only to a loopback address, validates the WebSocket origin and request host, and
requires a per-process token fetched from the same origin. It still exposes a real shell to the
browser, so it is intentionally unsuitable for deployment as a public terminal service.

The following environment variables are supported:

- `PORT`: HTTP and WebSocket port; defaults to `5174`.
- `HOST`: `127.0.0.1`, `localhost`, or `::1`; defaults to `127.0.0.1`.
- `PTY_CWD`: initial shell working directory; defaults to the current user's home directory.

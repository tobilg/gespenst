# @gespenst/bashkit

Run a stateful, single-process Bash interpreter entirely in the browser and connect it to
`@gespenst/core` through the native byte-stream transport. BashKit is single-threaded and does not
require `SharedArrayBuffer`, COOP, COEP, a server, or a PTY.

## Install

```sh
pnpm add @gespenst/core @gespenst/bashkit
```

## Terminal addon

```ts
import { BashKitAddon } from '@gespenst/bashkit';
import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';

const terminal = await createTerminal({ container, renderer: 'auto' });
const shell = new BashKitAddon({
  prompt: 'browser $ ',
  bash: {
    cwd: '/home/guest',
    username: 'guest',
    hostname: 'browser',
    files: { '/home/guest/README.md': 'Hello from BashKit\n' },
  },
});

terminal.loadAddon(shell);
const { session, connection } = await shell.ready;
await session.exit;
console.log(connection.status);
```

The terminal-side line editor supports command history, backspace, Ctrl-U, Ctrl-L, Ctrl-C, queued
typeahead, and mobile virtual-keyboard input. Use `session.bash` for BashKit's filesystem, command
analysis, commit, and checkout APIs.

BashKit supplies byte streams and does not own the renderer. Core may use WebGPU, WebGL2, or Canvas
2D—and may fall back between them—without replacing the interpreter or losing shell state.

## Lower-level session

```ts
import { createBashKitShell } from '@gespenst/bashkit';

const session = await createBashKitShell({ bash: { profile: 'hardened' } });
const connection = terminal.connect(session.transport);
```

## Capabilities and limits

BashKit includes Bash syntax and a built-in command set, but it is not a Linux VM or general process
host. It cannot launch arbitrary native, WASI, or WebC programs and does not receive PTY resize
notifications. Its single-process architecture is the portable choice for mobile browsers.

The runtime is dynamically imported on first use. Importing `@gespenst/bashkit` does not download
the BashKit WebAssembly asset until a session is activated. The first custom `wasm` source used in
a page controls process-wide initialization.

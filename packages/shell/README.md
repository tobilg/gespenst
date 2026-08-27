# @gespenst/shell

Attach a stateful Bash environment that runs entirely in the browser. `BrowserShellAddon` is the
stable high-level facade; it currently uses the single-process `@gespenst/bashkit` interpreter and
does not require a server, PTY, `SharedArrayBuffer`, or cross-origin isolation.

## Install

```sh
pnpm add @gespenst/core @gespenst/shell
```

## Usage

```ts
import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';
import { BrowserShellAddon } from '@gespenst/shell';

const terminal = await createTerminal({ container, renderer: 'auto' });
const shell = new BrowserShellAddon({
  bashkit: {
    bash: {
      cwd: '/home/guest',
      files: { '/home/guest/README.md': 'Browser-only shell\n' },
    },
    prompt: 'browser $ ',
  },
});

terminal.loadAddon(shell);
const ready = await shell.ready;
console.log(ready.backend); // "bashkit"
console.log(ready.session.capabilities);
```

`ready.backend` remains a discriminator so the facade can add a proven runtime in a future release
without obscuring which implementation is active. Shell and renderer selection are independent: a
core WebGPU → WebGL2 → Canvas 2D transition retains the BashKit session, terminal connection, and
shell state.

## Capabilities and limits

BashKit provides Bash syntax, command history, a stateful in-memory filesystem, and a curated
built-in command set. It is not a Linux VM: it cannot launch operating-system processes, arbitrary
WASI modules, or a server-side PTY. Inspect `ready.session.capabilities` instead of assuming those
features.

Use `@gespenst/bashkit` directly when an application needs implementation-specific APIs. Connect
`@gespenst/core` to `@gespenst/websocket` and a real server-side PTY when users need unrestricted
programs, host files, signals, job control, or system packages.

## Migrating from the multi-runtime preview

Delete the old `backend`, alternate-runtime, and `fallback` options. The `ready.reason` field and
alternate-runtime shell types no longer exist; `ready.backend` remains and is currently always
`"bashkit"`.

```ts
new BrowserShellAddon({ bashkit: options });
```

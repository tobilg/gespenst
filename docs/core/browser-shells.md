# Browser-only Shells

`@gespenst/shell` attaches a stateful Bash environment without a PTY server. It is the stable,
high-level facade over `@gespenst/bashkit`, so applications can depend on a small lifecycle API
while still accessing the active BashKit session when they need its filesystem or snapshot APIs.

Shell execution and terminal rendering are independent. A live session survives core moving from
WebGPU to WebGL2 or Canvas 2D after a graphics failure.

```sh
pnpm add @gespenst/core @gespenst/shell
```

```ts
import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';
import { BrowserShellAddon } from '@gespenst/shell';

const terminal = await createTerminal({ container, renderer: 'auto' });
const shell = new BrowserShellAddon({
  bashkit: {
    prompt: 'browser $ ',
    bash: {
      cwd: '/home/guest',
      files: { '/home/guest/README.md': 'Hello from this tab\n' },
    },
  },
});

terminal.loadAddon(shell);
const ready = await shell.ready;
console.log(ready.backend); // "bashkit"
console.log(ready.session.capabilities);
```

## Choose the right integration

| Integration | Best for | Important limitation |
| --- | --- | --- |
| `@gespenst/shell` | A portable browser-only Bash UI with a stable lifecycle API | Curated built-in commands rather than arbitrary system programs |
| `@gespenst/bashkit` | Direct filesystem, analysis, commit, and checkout access | Couples the application to the current interpreter |
| `@gespenst/websocket` plus a server PTY | Full operating-system shells, tools, job control, and signals | Requires an authenticated backend and session lifecycle |

BashKit understands Bash syntax, maintains shell state and history, and exposes a stateful virtual
filesystem. It is not a Linux virtual machine and cannot launch arbitrary native or WASI programs.
Inspect `ready.session.capabilities` when behavior depends on subprocesses, resize support, or
filesystem availability instead of inferring features from the package name.

## Lifecycle and error handling

`shell.ready` resolves only after the interpreter streams are connected to the terminal. Subscribe
to `onStatusChange` to drive loading, restart, and error UI:

```ts
const status = shell.onStatusChange((event) => {
  if (event.status === 'error') showShellError(event.error);
  if (event.status === 'exited') showRestartButton();
});

const { session, connection } = await shell.ready;
const exit = await session.exit;
console.log(exit.code, exit.reason, connection.status);

status.dispose();
```

Disposing the terminal disposes the addon, closes the connection, and terminates the interpreter.
Follow the page lifecycle pattern in [Events, Permissions, and Lifecycle](./events-permissions-lifecycle.md)
so a mobile back-forward-cache transition does not destroy a session that should be retained.

## Performance and deployment

The BashKit implementation is dynamically imported when the addon is activated, and its WebAssembly
module is initialized once per page. Each addon still receives an independent shell and filesystem.
The runtime is single-threaded and requires no PTY server, service worker, shared memory, or special
cross-origin isolation headers, which makes it suitable for static hosting and mobile browsers.

Keep `renderer: 'auto'` unless an application has measured a reason to force a backend. For a public
demo whose mobile browser matrix has unreliable worker-owned `OffscreenCanvas` updates, an
application may select `worker: false` without changing the shell implementation:

```ts
const terminal = await createTerminal({
  container,
  worker: isAffectedMobileBrowser ? false : 'dedicated',
  renderer: 'auto',
});
```

That is a rendering deployment policy, not a BashKit requirement. Prefer the default dedicated
worker when target devices pass the application's browser tests.

## Migrating from the multi-runtime preview

The shell facade now has one supported implementation. Remove the old `backend`, alternate-runtime,
and `fallback` options, along with code that branches on startup reasons. `ready.backend` remains as
a stable discriminator and currently always equals `"bashkit"`.

```ts
const shell = new BrowserShellAddon({
  bashkit: { bash: { cwd: '/home/guest' } },
});
```

## Related API

- {@link @gespenst/shell!BrowserShellAddon}
- {@link @gespenst/shell!BrowserShellAddonOptions}
- {@link @gespenst/shell!BrowserShellReady}
- {@link @gespenst/bashkit!BashKitShellSession}
- {@link @gespenst/bashkit!BashKitShellCapabilities}

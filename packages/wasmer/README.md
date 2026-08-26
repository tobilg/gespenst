# @gespenst/wasmer

Run an interactive WASIX shell entirely in the browser and connect it to
[`@gespenst/core`](https://github.com/tobilg/gespenst) through the native,
byte-oriented Web Streams transport.

The package dynamically loads `@wasmer/sdk`, so Wasmer's runtime is kept out of the initial bundle.
It includes an addon for the common case and lower-level session, transport, and virtual-filesystem
APIs for custom integrations. It does not change or extend the core terminal API.

> **v0.1 status:** The Wasmer runtime, raw WASI execution, transport, and lifecycle paths run in
> browser CI. The registry-backed Bash example remains an experimental integration because the
> package is hosted externally and guest resize is not exposed by `@wasmer/sdk`. Self-host the
> exact WebC artifact when availability and reproducibility matter.

## Install

```sh
pnpm add @gespenst/core @gespenst/wasmer @wasmer/sdk
```

## Browser requirements

Wasmer uses WebAssembly threads. The page must be served from a secure context and be
cross-origin isolated. Configure the server that hosts your application with these response
headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`localhost` is considered a secure context, but it still needs the isolation headers. Use
`getWasmerBrowserSupport()` to show a useful compatibility message before starting a shell.

## Terminal addon

```ts
import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';
import { WasmerAddon } from '@gespenst/wasmer';

const terminal = await createTerminal({
  container: document.querySelector<HTMLElement>('#terminal')!,
});

const shell = new WasmerAddon({
  package: {
    type: 'registry',
    specifier: 'sharrattj/bash@1.0.17',
  },
  env: { HOME: '/home/guest' },
});

terminal.loadAddon(shell);
const { session, connection } = await shell.ready;

await session.exit;
console.log(connection.status);
```

Even a pinned registry load relies on an external service. For deterministic production
deployments, self-host a WebC package and load it with a URL:

```ts
const shell = new WasmerAddon({
  package: {
    type: 'url',
    url: new URL('/wasix/bash.webc', location.href),
  },
});
```

Small standalone WASI or WASIX modules can be loaded directly without a WebC container:

```ts
const shell = new WasmerAddon({
  package: {
    type: 'wasm',
    data: await fetch('/wasix/my-command.wasm').then((response) => response.arrayBuffer()),
  },
});
```

Gespenst's browser suite runs a real WASI fixture through this path, including process startup,
streamed stdout, exit, and terminal transport shutdown. Interactive input and backpressure are
covered by the transport suite; registry and WebC loading remain separate because they depend on
the selected external package.

## Sessions and custom connections

Use `createWasmerShell()` when you need to manage the terminal connection yourself:

```ts
import { createWasmerShell } from '@gespenst/wasmer';

const session = await createWasmerShell({
  package: { type: 'registry', specifier: 'sharrattj/bash@1.0.17' },
});
const connection = terminal.connect(session.transport);

try {
  await session.exit;
} finally {
  connection.dispose();
  session.dispose();
}
```

An existing `@wasmer/sdk` instance can be adapted with `createWasmerSession()` or
`wasmerProcessTransport()`. Creating a managed session calls the SDK's consuming `wait()` operation;
do not call `wait()` or `free()` on that instance afterward.

## Configure the Bash prompt

The prompt belongs to Bash rather than to the terminal renderer. For a Wasmer shell, create a
virtual home directory containing the startup files and mount it into the guest. Providing both
`.profile` and `.bashrc` covers login and interactive non-login startup modes:

```ts
import { createTerminal } from '@gespenst/core';
import {
  createWasmerDirectory,
  WasmerAddon,
} from '@gespenst/wasmer';

const terminal = await createTerminal({ container });
const startup = String.raw`
export PS1='\[\e[38;5;81m\]gespenst\[\e[0m\] \w \$ '
`;
const home = await createWasmerDirectory({
  '.profile': startup,
  '.bashrc': startup,
});

const shell = new WasmerAddon({
  package: { type: 'registry', specifier: 'sharrattj/bash@1.0.17' },
  env: { HOME: '/home/guest' },
  mount: { '/home/guest': home },
});

terminal.loadAddon(shell);
await shell.ready;
```

Setting `env: { PS1: 'browser $ ' }` is sufficient when the package does not overwrite `PS1`, but
a startup file is more reliable. Bash prompt escapes such as `\w` and `\$` are expanded when the
prompt is drawn. Wrap ANSI styling in `\[` and `\]`; otherwise Bash may calculate the cursor
position incorrectly.

A running prompt can be changed through the same public input path used for composed text:

```ts
terminal.sendText(String.raw`export PS1='wasix \w \$ '` + '\r');
```

This sends an actual command to the guest. Use it only when Bash is waiting at a prompt, and never
interpolate untrusted content. Prefer startup files when the prompt should be deterministic from
the first frame.

Gespenst themes control terminal-wide defaults such as foreground, background, cursor, and
selection colors. Prompt text, segments, icons, and inline ANSI colors remain controlled by Bash.
Custom prompt glyphs require a font that contains them.

## Persistent virtual directories

`createWasmerDirectory()` creates a directory that can be mounted into multiple sequential shell
sessions and inspected from the host application:

```ts
import { createWasmerDirectory, createWasmerShell } from '@gespenst/wasmer';

const home = await createWasmerDirectory({
  'welcome.txt': 'This file is available inside the browser-only shell.\n',
});

const session = await createWasmerShell({
  package: { type: 'registry', specifier: 'sharrattj/bash@1.0.17' },
  env: { HOME: '/home/guest' },
  mount: { '/home/guest': home },
});

await home.writeFile('hello.txt', 'written from JavaScript');
console.log(await home.readTextFile('hello.txt'));

session.dispose();
home.dispose();
```

Directories have independent ownership: disposing a session does not dispose a directory supplied
by the caller.

## Lifecycle and limitations

- `session.close()` closes stdin and waits for a graceful process exit.
- `session.dispose()` aborts I/O and releases package and runtime resources. The SDK's `wait()`
  operation owns the process handle.
- Stdout and stderr are merged into the terminal's incoming byte stream as chunks arrive.
- `session.capabilities.resize` is currently `false`: `@wasmer/sdk` does not expose a PTY window
  size operation. The terminal itself can still resize, but the guest process is not notified.
- WASIX networking depends on the selected package, browser policy, and Wasmer runtime gateway.
- This is a browser-only package. It deliberately fails with a capability report in SSR and Node.js.

The first call to `initializeWasmer()`, `createWasmerDirectory()`, or `createWasmerShell()` controls
process-wide Wasmer initialization. Later calls reuse the initialized SDK.

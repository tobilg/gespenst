# Connecting a PTY

Connect terminal input and output without imposing a server protocol on the core package.

## The transport contract

`BrowserTerminal.connect()` accepts two byte streams:

- `readable` carries PTY output into Ghostty.
- `writable` carries encoded keyboard, text, paste, and terminal reply bytes back to the PTY.

The core does not create a process, authenticate a user, or define session control messages. Your
application owns those policies. The optional `@gespenst/websocket` package provides a
ready-made binary WebSocket convention with geometry messages and reconnect support.

## Connect a custom WebSocket

{@includeCode ../../examples/core/transport.ts#connect}

The example adapter keeps binary frames as bytes:

{@includeCode ../../examples/core/transport.ts#adapter}

For production, handle Blob frames, socket closure, cancellation, buffered socket output, and
authentication. The `socketTransport()` export from `@gespenst/websocket` already covers
the byte-stream and socket-lifecycle details.

## Keep PTY geometry in sync

Send the initial `terminal.geometry.cols` and `rows` when the session starts. Then subscribe to
`resize` and send each changed grid to the PTY backend. Resize messages should be control messages,
not terminal input bytes.

The event is emitted after the Ghostty backend has accepted the geometry. Its pixel fields are
device-pixel backing-surface measurements; PTY APIs normally need only columns and rows.

## Configure the shell prompt

The prompt is produced by the process connected to the PTY, not by Gespenst. The terminal parses
and renders the bytes it receives, just as a native terminal or xterm.js would. This keeps prompt
behavior, command history, exit status, current-directory expansion, and shell integrations under
the shell's control.

For Bash, set `PS1` in the environment or, more reliably, in a startup file controlled by the
server. A user's existing startup files can overwrite an inherited `PS1`, so use a dedicated
`--rcfile` when the application must guarantee the prompt:

```ts
const shell = pty.spawn('/bin/bash', ['--rcfile', '/opt/my-app/bashrc'], {
  name: 'xterm-256color',
  cols: terminal.geometry.cols,
  rows: terminal.geometry.rows,
  env: {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PS1: 'gespenst \\w \\$ ',
  },
});
```

The server should create `/opt/my-app/bashrc` and set `PS1` there if it needs to take precedence
over all other configuration. Other shells use different mechanisms: Zsh uses `PROMPT`/`RPROMPT`,
Fish defines a `fish_prompt` function, and PowerShell defines a `prompt` function.

ANSI color sequences and prompt escapes can be combined. Bash requires non-printing sequences to
be wrapped in `\[` and `\]` so that line editing calculates the cursor position correctly:

```bash
PS1='\[\e[38;5;81m\]gespenst\[\e[0m\] \w \$ '
```

To change a running Bash session from the browser, send a shell command as terminal input:

```ts
terminal.sendText(
  String.raw`export PS1='\[\e[35m\]gespenst\[\e[0m\] \w \$ '` + '\r',
);
```

This is equivalent to user input. Only do it when the shell is known to be waiting at a prompt;
otherwise the bytes may go to a foreground program or become part of an unfinished command. Avoid
interpolating untrusted values into shell commands. For remote sessions, configuring the process
at spawn time or using a separate authenticated control channel is safer.

If there is no shell or command interpreter, the application owns the prompt loop. It can render a
prompt with `writeAsync()`, consume terminal input, execute its own commands, and render the next
prompt:

```ts
await terminal.writeAsync('\x1b[35mgespenst\x1b[0m $ ');
```

Writing a prompt this way only paints terminal output; it does not configure an attached shell.
Prompt icons and Powerline separators also require the selected terminal font to contain the
corresponding glyphs.

## Newline handling belongs to the PTY

A real PTY applies terminal output processing such as converting line feed to carriage-return plus
line-feed when configured by the operating system. A raw process pipe does not. If output appears
diagonal after each newline, use a PTY library on the server or deliberately apply the required
output processing in a browser process adapter.

Do not make the renderer guess whether arbitrary bytes came from a PTY or a raw pipe.

## Backpressure and failure

Incoming chunks are processed sequentially with `writeAsync()`. Outgoing terminal input is queued
up to `highWaterMarkBytes`, which defaults to 1 MiB. The connection enters `error` if that queue is
exceeded or either stream fails.

Observe `connection.status`, `connection.closed`, or `onStatusChange()` to reflect connection state
in the UI. Use an `AbortSignal` or `connection.close()` when a route changes or a session is replaced.

## Security boundary

Authenticate and authorize the WebSocket upgrade. Restrict origins, validate control frames, cap
message sizes, disable compression when it adds no value for terminal bytes, and terminate the PTY
when its socket closes. The repository PTY example is loopback-only and intentionally not a
production remote-shell service.

## Related API

- {@link @gespenst/core!index.BrowserTerminal#connect | BrowserTerminal.connect}
- {@link @gespenst/core!index.TerminalTransport | TerminalTransport}
- {@link @gespenst/core!index.TerminalConnection | TerminalConnection}
- {@link @gespenst/core!core.TerminalGeometry | TerminalGeometry}
- {@link @gespenst/websocket!index.WebSocketAddon | WebSocketAddon}

# Events, Permissions, and Lifecycle

Treat terminal escape-sequence effects as application requests, not automatic browser actions.

## Geometry and policy events

{@includeCode ../../examples/core/events.ts#geometry}

The current geometry is available immediately as `terminal.geometry`. Subscribe before starting a
PTY when every subsequent size change matters, and send the initial value separately.

Terminal applications can request clipboard writes and desktop notifications. Handle their audit
and notification events at a product policy boundary:

{@includeCode ../../examples/core/events.ts#policy}

Gespenst 0.1.0 always denies remote clipboard writes; `clipboardWrite` records what was blocked and
must not be used to mirror the request into the browser clipboard. `@gespenst/clipboard` enables
user-initiated paste reads without changing that write policy. Request browser notification
permission from a user gesture, and consider session trust, origin, and visibility before showing
notifications.

## Event groups

- Input and layout: `input`, `resize`, `font`, `scroll`, `viewportChange`, `bufferChange`,
  `selectionChange`.
- Terminal state: `title`, `cwd`, `progress`, `bell`.
- Browser policy: `clipboardWrite`, `notification`.
- Runtime state: `renderer`, `writeParsed`, `error`.

Every `on()` call returns a disposable subscription. Dispose subscriptions owned by a shorter-lived
component before disposing the terminal. Terminal disposal clears any remaining listeners.

`terminal.renderer` is the live selected backend and provides the initial value after creation. The
`renderer` event reports successful same-backend restoration and runtime fallback such as WebGPU →
WebGL2. Use it to update diagnostics or performance labels; shell transports and addons remain
attached.

`scroll` carries the absolute zero-based offset of the first visible row. `viewportChange` is
emitted after a frame is painted and includes that offset together with total rows, scrollback,
viewport length, active screen, cursor position, and a monotonic buffer revision. Use it for custom
scrollbars and overlays that must stay aligned with the painted viewport.

`bufferChange` invalidates retained-buffer consumers after writes, resize/reflow, reset, restore, or
a scrollback-limit change. It includes the reason and deliberately does not fire for viewport-only
scrolling, font changes, or theme changes. Addons can therefore rescan text on `bufferChange` while
redrawing cached coordinates cheaply on `viewportChange`.

## Connection lifecycle

A `TerminalConnection` moves through `connecting`, `open`, `closing`, `closed`, or `error`. Reflect
those states in the product UI so users can distinguish a shell exit from a broken connection.

`closed` rejects on a transport error and resolves after a normal close. Handle that promise even if
status events drive the visible UI. `connect()` accepts an `AbortSignal` for route or session
cancellation.

## Addon ownership

Calling `loadAddon()` transfers disposal ownership to the terminal. Addons are disposed in reverse
activation order. This lets a transport or behavior addon detach before the underlying renderer and
event system are released.

Do not load the same addon instance into multiple terminals unless that addon explicitly documents
support for it.

## Page and component lifecycle

Dispose a terminal when the view that owns it is actually removed. React, Vue, and Svelte bindings
already do this during component unmount. In a custom element or other application-owned view, call
`terminal.dispose()` from that view's teardown callback.

A browser page needs a different policy because `pagehide` does not always mean permanent teardown.
Mobile browsers use the back-forward cache (BFCache) aggressively and set
[`event.persisted`](https://developer.mozilla.org/docs/Web/API/PageTransitionEvent/persisted) when they
intend to preserve the document. Disposing in that case closes workers, connections, addons, and
any browser-only shell session.

Use a non-one-shot `pagehide` listener so a persisted hide can be followed by a later permanent
hide. Refit on a persisted `pageshow`, and restore focus only if the terminal owned focus before it
was hidden:

{@includeCode ../../examples/core/events.ts#lifecycle}

Do not use `beforeunload` as the primary cleanup mechanism. It is unreliable on mobile, and merely
registering a listener can reduce BFCache eligibility in some browsers. If the browser terminates a
document without delivering a final lifecycle event, it releases that document's resources itself.

Keeping the terminal alive does not guarantee that a remote PTY remains connected while a mobile
page is suspended. Observe the transport or addon status and provide reconnection UI. For
`@gespenst/websocket`, enable its reconnect policy when reconnecting to the same session is valid.
For a local browser-only shell, observe the session's `exit` promise and offer an explicit restart
if the session ended while the page was suspended.

## Related API

- {@link @gespenst/core!index.BrowserTerminalEventMap | BrowserTerminalEventMap}
- {@link @gespenst/core!core.TerminalEventMap | TerminalEventMap}
- {@link @gespenst/core!index.TerminalConnectionStatus | TerminalConnectionStatus}
- {@link @gespenst/core!index.TerminalAddon | TerminalAddon}
- {@link @gespenst/core!index.BrowserTerminal#fit | BrowserTerminal.fit}
- {@link @gespenst/core!index.BrowserTerminal#dispose | BrowserTerminal.dispose}
- {@link @gespenst/core!core.Disposable | Disposable}

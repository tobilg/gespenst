---
title: Clipboard and MIME Paste
---

# Clipboard and MIME Paste

Clipboard support is deliberately optional. Install `@gespenst/clipboard` when a terminal should
accept browser paste events or expose the Kitty clipboard protocol to applications running through
the PTY.

```sh
pnpm add @gespenst/core @gespenst/clipboard
```

```ts
import { ClipboardAddon } from '@gespenst/clipboard';

const clipboard = new ClipboardAddon({
  maxBytes: 32 * 1024 * 1024,
  snapshotTtlMs: 30_000,
  confirmUnsafePaste: ({ text }) => {
    return window.confirm(`Paste this text into the terminal?\n\n${text}`);
  },
  onError(error) {
    console.error(error.code, error.message);
  },
});

terminal.loadAddon(clipboard);
await clipboard.ready;
```

The addon listens for native `paste` events on the terminal. When a terminal application has
enabled private mode 5522, Gespenst sends the available MIME types and holds the data in a
short-lived snapshot. The application can then request representations such as `image/png` or
`text/html` over OSC 5522. Ghostty parses and encodes the protocol; Gespenst supplies browser bytes
and policy.

When mode 5522 is not enabled, the first text representation uses the ordinary paste path and
honors bracketed-paste mode. Binary-only clipboard data produces an `empty` result rather than being
converted or discarded into the PTY.

## Custom paste controls

Programmatic browser clipboard reads must remain inside a user activation. Do not insert an
unrelated timeout or network request before calling `pasteFromClipboard()`:

```ts
pasteButton.addEventListener('click', async () => {
  try {
    const result = await clipboard.pasteFromClipboard();
    if (result.status === 'unsafe') {
      showStatus('Paste cancelled because it could execute commands');
    }
  } catch (error) {
    showStatus('Clipboard permission was not granted');
  }
});
```

`navigator.clipboard.read()` supplies all available MIME representations where the browser supports
it. The addon falls back to `readText()` on browsers with text-only clipboard access. HTTPS or
localhost is normally required.

## Security model

| Action | Default behavior |
| --- | --- |
| User presses paste inside the terminal | Read and paste through the addon |
| Trusted UI calls `pasteFromClipboard()` | Read during the caller's user activation |
| Remote application requests clipboard data without a paste event | Deny |
| Remote application writes through OSC 52 or OSC 5522 | Deny; emit the existing audit event |
| Multiline text without bracketed paste | Return `unsafe` |
| Text containing a bracketed-paste terminator | Return `unsafe` |

Unsafe text stays rejected unless `confirmUnsafePaste` exists and resolves to `true`. Show the exact
text and require an explicit decision in that callback. Do not approve based only on PTY or host
identity; a compromised process connected to a trusted shell can still emit terminal sequences.

The default 32 MiB transaction limit prevents a clipboard item from creating an unbounded worker
message or WASM allocation. The default 30-second snapshot lifetime limits how long a Kitty paste
password can retrieve data. Each data request consumes the current snapshot, and a subsequent paste
replaces any older one.

## Performance notes

- Data remains `Uint8Array`/`ArrayBuffer` across the browser API, worker boundary, and Ghostty ABI.
- The worker transfer uses transferable buffers, avoiding structured-clone copies of large images.
- Clipboard bytes are read only on paste, never polled.
- Remote writes are rejected inside the synchronous Ghostty callback and never touch browser APIs.

## Related API

- {@link @gespenst/clipboard!ClipboardAddon}
- {@link @gespenst/clipboard!ClipboardAddonOptions}
- {@link @gespenst/clipboard!ClipboardAddonError}

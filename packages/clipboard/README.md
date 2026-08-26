# @gespenst/clipboard

Opt-in, permission-aware browser clipboard support for `@gespenst/core`, including MIME-aware paste
events from the [Kitty clipboard protocol](https://sw.kovidgoyal.net/kitty/clipboard/).

## Install

```sh
pnpm add @gespenst/core @gespenst/clipboard
```

## Use

```ts
import { ClipboardAddon } from '@gespenst/clipboard';

const clipboard = new ClipboardAddon({
  confirmUnsafePaste: async ({ text }) => {
    return showPasteConfirmation(text);
  },
  onError(error) {
    showToast(`Clipboard failed: ${error.message}`);
  },
});

terminal.loadAddon(clipboard);
await clipboard.ready;
```

Loading the addon intercepts native paste events inside the terminal. Text falls back to normal
bracketed paste when the running application does not enable Kitty mode 5522. Applications that do
enable mode 5522 receive an event containing the available MIME types and can request an image,
rich text, or another representation through the PTY.

For a custom paste button, keep the clipboard read in the click handler so browser user activation
is still valid:

```ts
pasteButton.addEventListener('click', async () => {
  const result = await clipboard.pasteFromClipboard();
  if (result.status === 'unsafe') showToast('Paste cancelled');
});
```

## Security policy

- Clipboard access is disabled in core until this addon is loaded.
- Reads happen only for native paste events or explicit calls to `pasteFromClipboard()`.
- Remote OSC 52 and OSC 5522 writes are denied in version 0.1.0; the browser clipboard is never
  modified by terminal output.
- Multiline or bracketed-paste-terminator text is rejected when it cannot be pasted safely.
  `confirmUnsafePaste` is the only opt-in override.
- At most 32 MiB is accepted by default, and a Kitty MIME snapshot expires after 30 seconds. Both
  limits are configurable.
- A one-time Kitty paste password can consume only the latest snapshot. A newer paste replaces it.

Browser clipboard reads generally require HTTPS or localhost and a current user activation. Native
paste events are the most portable route because the browser supplies their `DataTransfer`
directly.

## MIME behavior

When `navigator.clipboard.read()` is available, every representation exposed by each
`ClipboardItem` is forwarded as raw bytes. Otherwise `readText()` provides `text/plain`. Duplicate
MIME types are removed, MIME names are normalized to lowercase, and the total byte limit is checked
before data reaches the terminal worker.

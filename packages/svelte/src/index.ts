import { type BrowserTerminal, createTerminal, type TerminalOptions } from '@gespenst/core';

/** Options accepted by the {@link gespenstTerminal} Svelte action. */
export interface GespenstTerminalActionOptions extends Omit<TerminalOptions, 'container'> {
  /** Called once the asynchronous terminal is ready. */
  readonly onReady?: (terminal: BrowserTerminal) => void;
  /** Called when terminal creation fails. */
  readonly onError?: (error: Error) => void;
}

/**
 * Svelte action that mounts a terminal into `node`, applies supported option updates, and disposes
 * it when the action is destroyed.
 */
export function gespenstTerminal(node: HTMLElement, options: GespenstTerminalActionOptions = {}) {
  let disposed = false;
  let terminal: BrowserTerminal | null = null;
  let latest = options;
  const { onReady: _onReady, onError: _onError, ...terminalOptions } = options;
  void createTerminal({ ...terminalOptions, container: node })
    .then((created) => {
      if (disposed) return created.dispose();
      terminal = created;
      applyMutableOptions(created, latest);
      latest.onReady?.(created);
    })
    .catch((error) => {
      if (!disposed) latest.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  return {
    /** Applies mutable font and theme values to the active terminal. */
    update(next: GespenstTerminalActionOptions) {
      latest = next;
      if (terminal) applyMutableOptions(terminal, next);
    },
    /** Disposes the terminal and prevents an in-flight creation from being retained. */
    destroy() {
      disposed = true;
      terminal?.dispose();
    },
  };
}

function applyMutableOptions(
  terminal: BrowserTerminal,
  options: GespenstTerminalActionOptions
): void {
  const font = {
    ...(options.fontFamily === undefined ? {} : { family: options.fontFamily }),
    ...(options.fontSizePx === undefined ? {} : { sizePx: options.fontSizePx }),
    ...(options.lineHeight === undefined ? {} : { lineHeight: options.lineHeight }),
    ...(options.fontWeight === undefined ? {} : { weight: options.fontWeight }),
    ...(options.fontWeightBold === undefined ? {} : { boldWeight: options.fontWeightBold }),
    ...(options.letterSpacingPx === undefined ? {} : { letterSpacingPx: options.letterSpacingPx }),
  };
  if (Object.keys(font).length > 0) void terminal.setFont(font);
  if (options.theme) void terminal.setTheme(options.theme);
}

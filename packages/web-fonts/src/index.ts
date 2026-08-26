import type {
  BrowserTerminal,
  TerminalAddon,
  TerminalFontOptions,
  TerminalGeometry,
} from '@gespenst/core';

/** Describes a browser font face to load for a terminal. */
export interface WebFontDefinition {
  /** Font-family name made available to the terminal renderer. */
  readonly family: string;
  /** CSS font source string or raw font bytes. */
  readonly source: string | ArrayBuffer;
  /** Optional descriptors forwarded to the browser `FontFace` constructor. */
  readonly descriptors?: FontFaceDescriptors;
}

/** Loads web fonts through the terminal's worker-safe font API. */
export class WebFontsAddon implements TerminalAddon {
  private terminal: BrowserTerminal | null = null;

  /** Attaches the addon to a terminal. Called by `terminal.loadAddon()`. */
  activate(terminal: BrowserTerminal): void {
    this.terminal = terminal;
  }

  /** Loads every definition, applies the font options, and returns the resulting geometry. */
  async load(
    definitions: readonly WebFontDefinition[],
    options: Partial<TerminalFontOptions> = {}
  ): Promise<TerminalGeometry> {
    if (!this.terminal) throw new Error('WebFontsAddon is not active');
    for (const definition of definitions) {
      await this.terminal.loadFont({
        family: definition.family,
        source:
          typeof definition.source === 'string' ? definition.source : definition.source.slice(0),
        ...(definition.descriptors ? { descriptors: definition.descriptors } : {}),
      });
    }
    return this.terminal.setFont(options);
  }

  /** Releases the active terminal reference. */
  dispose(): void {
    this.terminal = null;
  }
}

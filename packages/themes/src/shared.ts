import type { TerminalTheme } from '@gespenst/core';

/** Freezes a catalog theme while exposing the stable core theme contract. */
export function frozen(theme: TerminalTheme): Readonly<TerminalTheme> {
  return Object.freeze(theme);
}

/** Attribution and display metadata for a built-in theme. */
export interface ThemeMetadata {
  /** Human-readable name suitable for a theme picker. */
  readonly label: string;
  /** Whether the theme is designed for a dark or light surrounding UI. */
  readonly appearance: 'dark' | 'light';
  /** Canonical upstream project used as the palette source. */
  readonly source: string;
  /** Upstream commit used to audit the palette and license. */
  readonly revision: string;
  /** SPDX license identifier for the upstream palette. */
  readonly license: string;
}

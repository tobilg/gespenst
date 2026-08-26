export { catppuccinLatte } from './catppuccin-latte.js';
export { catppuccinMocha } from './catppuccin-mocha.js';
export { dracula } from './dracula.js';
export { gespenstDark } from './gespenst-dark.js';
export { gespenstLight } from './gespenst-light.js';
export { gruvboxDark } from './gruvbox-dark.js';
export { gruvboxLight } from './gruvbox-light.js';
export { nord } from './nord.js';
export type { ThemeMetadata } from './shared.js';
export { solarizedDark } from './solarized-dark.js';
export { solarizedLight } from './solarized-light.js';
export { tokyoNightDay } from './tokyo-night-day.js';
export { tokyoNightStorm } from './tokyo-night-storm.js';

import type { TerminalTheme } from '@gespenst/core';
import { catppuccinLatte } from './catppuccin-latte.js';
import { catppuccinMocha } from './catppuccin-mocha.js';
import { dracula } from './dracula.js';
import { gespenstDark } from './gespenst-dark.js';
import { gespenstLight } from './gespenst-light.js';
import { gruvboxDark } from './gruvbox-dark.js';
import { gruvboxLight } from './gruvbox-light.js';
import { nord } from './nord.js';
import type { ThemeMetadata } from './shared.js';
import { solarizedDark } from './solarized-dark.js';
import { solarizedLight } from './solarized-light.js';
import { tokyoNightDay } from './tokyo-night-day.js';
import { tokyoNightStorm } from './tokyo-night-storm.js';

/** Name accepted by the built-in theme registry. */
export type ThemeName =
  | 'gespenstDark'
  | 'gespenstLight'
  | 'dracula'
  | 'catppuccinMocha'
  | 'catppuccinLatte'
  | 'tokyoNightStorm'
  | 'tokyoNightDay'
  | 'nord'
  | 'gruvboxDark'
  | 'gruvboxLight'
  | 'solarizedDark'
  | 'solarizedLight';

/** All built-in themes keyed by stable, type-safe names. */
export const themes: Readonly<Record<ThemeName, Readonly<TerminalTheme>>> = Object.freeze({
  gespenstDark,
  gespenstLight,
  dracula,
  catppuccinMocha,
  catppuccinLatte,
  tokyoNightStorm,
  tokyoNightDay,
  nord,
  gruvboxDark,
  gruvboxLight,
  solarizedDark,
  solarizedLight,
});

/** Attribution and appearance information for every built-in theme. */
export const themeMetadata: Readonly<Record<ThemeName, ThemeMetadata>> = Object.freeze({
  gespenstDark: {
    label: 'Gespenst Dark',
    appearance: 'dark',
    source: 'https://github.com/tobilg/gespenst',
    revision: 'workspace',
    license: 'MIT',
  },
  gespenstLight: {
    label: 'Gespenst Light',
    appearance: 'light',
    source: 'https://github.com/tobilg/gespenst',
    revision: 'workspace',
    license: 'MIT',
  },
  dracula: {
    label: 'Dracula',
    appearance: 'dark',
    source: 'https://github.com/dracula/dracula-theme',
    revision: '2985f660b04e6961b0887ffac2f8d3f35f431698',
    license: 'MIT',
  },
  catppuccinMocha: {
    label: 'Catppuccin Mocha',
    appearance: 'dark',
    source: 'https://github.com/catppuccin/catppuccin',
    revision: 'd09787dd98ca6fba08af5ef2ae94a7e09f17daca',
    license: 'MIT',
  },
  catppuccinLatte: {
    label: 'Catppuccin Latte',
    appearance: 'light',
    source: 'https://github.com/catppuccin/catppuccin',
    revision: 'd09787dd98ca6fba08af5ef2ae94a7e09f17daca',
    license: 'MIT',
  },
  tokyoNightStorm: {
    label: 'Tokyo Night Storm',
    appearance: 'dark',
    source: 'https://github.com/tokyo-night/tokyo-night-vscode-theme',
    revision: '7c0f11eaef322f293621ca7befe462214b7ea468',
    license: 'MIT',
  },
  tokyoNightDay: {
    label: 'Tokyo Night Day',
    appearance: 'light',
    source: 'https://github.com/tokyo-night/tokyo-night-vscode-theme',
    revision: '7c0f11eaef322f293621ca7befe462214b7ea468',
    license: 'MIT',
  },
  nord: {
    label: 'Nord',
    appearance: 'dark',
    source: 'https://github.com/nordtheme/nord',
    revision: '1cef71605416a222e57225b544540ce0fcec18d4',
    license: 'MIT',
  },
  gruvboxDark: {
    label: 'Gruvbox Dark',
    appearance: 'dark',
    source: 'https://github.com/morhetz/gruvbox',
    revision: '5d15b2765f59754d7ac263c88a0f6e3e58124951',
    license: 'MIT',
  },
  gruvboxLight: {
    label: 'Gruvbox Light',
    appearance: 'light',
    source: 'https://github.com/morhetz/gruvbox',
    revision: '5d15b2765f59754d7ac263c88a0f6e3e58124951',
    license: 'MIT',
  },
  solarizedDark: {
    label: 'Solarized Dark',
    appearance: 'dark',
    source: 'https://github.com/altercation/solarized',
    revision: '62f656a02f93c5190a8753159e34b385588d5ff3',
    license: 'MIT',
  },
  solarizedLight: {
    label: 'Solarized Light',
    appearance: 'light',
    source: 'https://github.com/altercation/solarized',
    revision: '62f656a02f93c5190a8753159e34b385588d5ff3',
    license: 'MIT',
  },
});

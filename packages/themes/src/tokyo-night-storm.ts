import { frozen } from './shared.js';

/** Tokyo Night's dark Storm palette. */
export const tokyoNightStorm = frozen({
  appearance: 'dark',
  background: '#24283b',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#24283b',
  selectionBackground: '#364a82',
  selectionInactiveBackground: '#2e3c64',
  black: '#1d202f',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5',
} as const);

/** Default subpath export. */
export default tokyoNightStorm;

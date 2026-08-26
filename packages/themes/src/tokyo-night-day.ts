import { frozen } from './shared.js';

/** Tokyo Night's light Day palette. */
export const tokyoNightDay = frozen({
  appearance: 'light',
  background: '#e1e2e7',
  foreground: '#3760bf',
  cursor: '#3760bf',
  cursorAccent: '#e1e2e7',
  selectionBackground: '#b6bfe2',
  selectionInactiveBackground: '#cbd0e5',
  black: '#0f0f14',
  red: '#f52a65',
  green: '#587539',
  yellow: '#8c6c3e',
  blue: '#2e7de9',
  magenta: '#9854f1',
  cyan: '#007197',
  white: '#6172b0',
  brightBlack: '#a1a6c5',
  brightRed: '#f52a65',
  brightGreen: '#587539',
  brightYellow: '#8c6c3e',
  brightBlue: '#2e7de9',
  brightMagenta: '#9854f1',
  brightCyan: '#007197',
  brightWhite: '#3760bf',
} as const);

/** Default subpath export. */
export default tokyoNightDay;

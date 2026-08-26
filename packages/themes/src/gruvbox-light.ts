import { frozen } from './shared.js';

/** Gruvbox's light terminal palette. */
export const gruvboxLight = frozen({
  appearance: 'light',
  background: '#fbf1c7',
  foreground: '#3c3836',
  cursor: '#3c3836',
  cursorAccent: '#fbf1c7',
  selectionBackground: '#d5c4a1',
  selectionInactiveBackground: '#ebdbb2',
  black: '#fbf1c7',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#7c6f64',
  brightBlack: '#928374',
  brightRed: '#9d0006',
  brightGreen: '#79740e',
  brightYellow: '#b57614',
  brightBlue: '#076678',
  brightMagenta: '#8f3f71',
  brightCyan: '#427b58',
  brightWhite: '#3c3836',
} as const);

/** Default subpath export. */
export default gruvboxLight;

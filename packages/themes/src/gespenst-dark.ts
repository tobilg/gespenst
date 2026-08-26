import { frozen } from './shared.js';

/** The native Gespenst dark theme and `@gespenst/core` default palette. */
export const gespenstDark = frozen({
  appearance: 'dark',
  background: '#1d1f21',
  foreground: '#c5c8c6',
  cursor: '#c5c8c6',
  cursorAccent: '#1d1f21',
  selectionBackground: 'rgba(197, 200, 198, 0.3)',
  selectionInactiveBackground: 'rgba(197, 200, 198, 0.15)',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d57878',
  brightGreen: '#c3ca7c',
  brightYellow: '#f9d78e',
  brightBlue: '#95b6d2',
  brightMagenta: '#c6a8cf',
  brightCyan: '#9ed2cb',
  brightWhite: '#ffffff',
} as const);

/** Default subpath export. */
export default gespenstDark;

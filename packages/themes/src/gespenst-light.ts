import { frozen } from './shared.js';

/** A neutral light companion to the default Gespenst theme. */
export const gespenstLight = frozen({
  appearance: 'light',
  background: '#f7f7f5',
  foreground: '#242628',
  cursor: '#242628',
  cursorAccent: '#f7f7f5',
  selectionBackground: 'rgba(63, 104, 144, 0.28)',
  selectionInactiveBackground: 'rgba(63, 104, 144, 0.14)',
  black: '#242628',
  red: '#a83232',
  green: '#527a24',
  yellow: '#9a6700',
  blue: '#356a9a',
  magenta: '#80558c',
  cyan: '#267a72',
  white: '#d9dad7',
  brightBlack: '#6b6d6e',
  brightRed: '#c14545',
  brightGreen: '#66952e',
  brightYellow: '#b57b00',
  brightBlue: '#487fae',
  brightMagenta: '#9869a4',
  brightCyan: '#338f86',
  brightWhite: '#ffffff',
} as const);

/** Default subpath export. */
export default gespenstLight;

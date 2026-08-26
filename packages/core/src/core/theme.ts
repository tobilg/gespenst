import type {
  ResolvedTerminalTheme,
  RgbaColor,
  RgbColor,
  TerminalColor,
  TerminalTheme,
  ThemeAppearance,
} from './types.js';

/** Ordered xterm-compatible names for ANSI palette entries 0 through 15. */
export const ANSI_COLOR_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const satisfies readonly (keyof TerminalTheme)[];

const DEFAULT_THEME_VALUES = Object.freeze({
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
} as const satisfies TerminalTheme);

/** Default terminal theme used when individual colors are not supplied. */
export const DEFAULT_THEME: Readonly<TerminalTheme> = DEFAULT_THEME_VALUES;

/** Error thrown when a theme contains an unsupported or malformed color. */
export class ThemeValidationError extends TypeError {
  /** Property or palette index containing the invalid color. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid terminal theme color at ${path}: ${message}`);
    this.name = 'ThemeValidationError';
    this.path = path;
  }
}

/** Function that completes a 256-color palette from base colors and explicit indices. */
export type PaletteGenerator = (
  base: readonly RgbColor[],
  preserved: ReadonlySet<number>,
  background: RgbColor,
  foreground: RgbColor,
  harmonious: boolean
) => readonly RgbColor[];

function byte(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 255)
    throw new ThemeValidationError(path, 'RGB channels must be finite numbers from 0 to 255');
  return Math.round(value);
}

function alpha(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new ThemeValidationError(path, 'alpha must be a finite number from 0 to 1');
  return value;
}

function component(value: string, path: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return byte((Number.parseFloat(trimmed) / 100) * 255, path);
  return byte(Number.parseFloat(trimmed), path);
}

function alphaComponent(value: string, path: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return alpha(Number.parseFloat(trimmed) / 100, path);
  return alpha(Number.parseFloat(trimmed), path);
}

/** Parses a color accepted by the portable Gespenst theme API. */
export function parseTerminalColor(value: TerminalColor, path = 'color'): RgbaColor {
  if (typeof value !== 'string') {
    const candidate = value as RgbColor & { readonly a?: number };
    return Object.freeze({
      r: byte(candidate.r, `${path}.r`),
      g: byte(candidate.g, `${path}.g`),
      b: byte(candidate.b, `${path}.b`),
      a: candidate.a === undefined ? 1 : alpha(candidate.a, `${path}.a`),
    });
  }

  const input = value.trim();
  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.exec(input)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((part) => part.repeat(2)).join('') : hex;
    return Object.freeze({
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    });
  }

  const functional = /^(rgba?)\((.*)\)$/iu.exec(input);
  if (functional) {
    const functionName = functional[1]?.toLowerCase();
    const body = functional[2] ?? '';
    let channels: string[];
    let opacity: string | undefined;
    if (body.includes(',')) {
      const parts = body.split(',').map((part) => part.trim());
      channels = parts.slice(0, 3);
      opacity = parts[3];
    } else {
      const [rgb = '', alphaValue] = body.split('/').map((part) => part.trim());
      channels = rgb.split(/\s+/u).filter(Boolean);
      opacity = alphaValue;
    }
    if (channels.length === 3 && (functionName === 'rgb' || opacity !== undefined)) {
      return Object.freeze({
        r: component(channels[0] ?? '', `${path}.r`),
        g: component(channels[1] ?? '', `${path}.g`),
        b: component(channels[2] ?? '', `${path}.b`),
        a: opacity === undefined ? 1 : alphaComponent(opacity, `${path}.a`),
      });
    }
  }
  throw new ThemeValidationError(
    path,
    'expected #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), or an RGB(A) object'
  );
}

/** Serializes a terminal color as a portable CSS `rgba()` value. */
export function terminalColorToCss(value: TerminalColor): string {
  const color = parseTerminalColor(value);
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;
}

function fallbackPalette(base: readonly RgbColor[]): RgbColor[] {
  const result = base.slice(0, 16).map((value) => ({ ...value }));
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        result.push({ r: levels[r] ?? 0, g: levels[g] ?? 0, b: levels[b] ?? 0 });
      }
    }
  }
  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    result.push({ r: value, g: value, b: value });
  }
  return result;
}

function appearanceFor(background: RgbColor): ThemeAppearance {
  return (background.r * 0.299 + background.g * 0.587 + background.b * 0.114) / 255 > 0.5
    ? 'light'
    : 'dark';
}

/** Resolves defaults, validates colors, and produces a complete palette. */
export function resolveTerminalTheme(
  theme: TerminalTheme = {},
  generatePalette: PaletteGenerator = fallbackPalette
): ResolvedTerminalTheme {
  const foreground = parseTerminalColor(
    theme.foreground ?? DEFAULT_THEME_VALUES.foreground,
    'foreground'
  );
  const background = parseTerminalColor(
    theme.background ?? DEFAULT_THEME_VALUES.background,
    'background'
  );
  const cursor = parseTerminalColor(theme.cursor ?? DEFAULT_THEME_VALUES.cursor, 'cursor');
  const cursorAccent = parseTerminalColor(
    theme.cursorAccent ?? theme.background ?? DEFAULT_THEME_VALUES.cursorAccent,
    'cursorAccent'
  );
  const selectionBackground = parseTerminalColor(
    theme.selectionBackground ?? DEFAULT_THEME_VALUES.selectionBackground,
    'selectionBackground'
  );
  const selectionForeground =
    theme.selectionForeground === undefined
      ? null
      : parseTerminalColor(theme.selectionForeground, 'selectionForeground');
  const selectionInactiveBackground = parseTerminalColor(
    theme.selectionInactiveBackground ?? DEFAULT_THEME_VALUES.selectionInactiveBackground,
    'selectionInactiveBackground'
  );

  const palette: RgbaColor[] = ANSI_COLOR_NAMES.map((name, index) =>
    parseTerminalColor(DEFAULT_THEME_VALUES[name], `palette[${index}]`)
  );
  const preserved = new Set<number>();
  theme.palette?.slice(0, 256).forEach((value, index) => {
    palette[index] = parseTerminalColor(value, `palette[${index}]`);
    preserved.add(index);
  });
  ANSI_COLOR_NAMES.forEach((name, index) => {
    const value = theme[name];
    if (value === undefined) return;
    palette[index] = parseTerminalColor(value, name);
    preserved.add(index);
  });
  const base = Array.from({ length: 256 }, (_, index) => {
    const value = palette[index] ?? { r: 0, g: 0, b: 0, a: 1 };
    return { r: value.r, g: value.g, b: value.b };
  });
  const generated = generatePalette(
    base,
    preserved,
    background,
    foreground,
    theme.appearance === 'light' ||
      (theme.appearance === undefined && appearanceFor(background) === 'light')
  );
  const fallback = generated.length >= 256 ? generated : fallbackPalette(base);
  for (let index = 16; index < 256; index += 1) {
    const generatedColor = generated[index] ?? fallback[index] ?? { r: 0, g: 0, b: 0 };
    const explicit = palette[index];
    palette[index] = explicit ?? Object.freeze({ ...generatedColor, a: 1 });
  }
  theme.extendedAnsi?.slice(0, 240).forEach((value, offset) => {
    palette[offset + 16] = parseTerminalColor(value, `extendedAnsi[${offset}]`);
  });

  return Object.freeze({
    appearance: theme.appearance ?? appearanceFor(background),
    foreground,
    background,
    cursor,
    cursorAccent,
    selectionBackground,
    selectionForeground,
    selectionInactiveBackground,
    palette: Object.freeze(palette),
  });
}

/** Returns a detached theme patch suitable for storing or exposing publicly. */
export function cloneTerminalTheme(theme: TerminalTheme): TerminalTheme {
  return Object.freeze({
    ...theme,
    ...(theme.palette ? { palette: Object.freeze([...theme.palette]) } : {}),
    ...(theme.extendedAnsi ? { extendedAnsi: Object.freeze([...theme.extendedAnsi]) } : {}),
  });
}

/** Merges a theme patch without mutating either input. */
export function mergeTerminalTheme(theme: TerminalTheme, patch: TerminalTheme): TerminalTheme {
  return cloneTerminalTheme({ ...theme, ...patch });
}

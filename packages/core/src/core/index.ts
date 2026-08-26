import metadata from '../assets/ghostty-vt.meta.json';
import type { GhosttyBuildMetadata } from './types.js';

/** Metadata and checksum for the vendored nightly Ghostty WASM build. */
export const GHOSTTY_BUILD: GhosttyBuildMetadata = metadata;

export { GhosttyAbi, UnsupportedGhosttyAbiError } from './abi.js';
export { GhosttyError } from './bindings.js';
export type { LoadedGhostty } from './loader.js';
export {
  DEFAULT_CALLBACKS_URL,
  DEFAULT_WASM_URL,
  loadCallbackBridge,
  loadGhostty,
  preloadGhostty,
} from './loader.js';
export { CoreRuntime, createCoreRuntime } from './runtime.js';
export { CoreTerminal } from './terminal.js';
export type { PaletteGenerator } from './theme.js';
export {
  ANSI_COLOR_NAMES,
  cloneTerminalTheme,
  DEFAULT_THEME,
  mergeTerminalTheme,
  parseTerminalColor,
  resolveTerminalTheme,
  ThemeValidationError,
  terminalColorToCss,
} from './theme.js';
export type * from './types.js';
export { KeyModifiers } from './types.js';

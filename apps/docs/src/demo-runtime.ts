import type { TerminalOptions } from '@gespenst/core';

/** Browser values used to select the most reliable docs-demo execution path. */
export interface DemoBrowserPlatform {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
}

export type DemoTerminalRuntimeOptions = Pick<TerminalOptions, 'renderer' | 'worker'>;

/** Whether every browser on this device is constrained to Apple's mobile WebKit runtime. */
export function isAppleMobileBrowser(platform: DemoBrowserPlatform = navigator): boolean {
  const appleMobile = /\b(?:iPad|iPhone|iPod)\b/.test(platform.userAgent);
  const desktopClassIpad = platform.platform === 'MacIntel' && platform.maxTouchPoints > 1;
  return appleMobile || desktopClassIpad;
}

/**
 * Keeps the public demo conservative on physical iOS WebKit.
 *
 * The terminal package still defaults to its worker and accelerated renderer cascade. The docs
 * keep rendering on the main thread on iOS because physical devices have previously stalled
 * worker-owned OffscreenCanvas updates, while retaining the WebGPU → WebGL2 → Canvas 2D ladder.
 */
export function demoTerminalRuntime(
  platform: DemoBrowserPlatform = navigator
): DemoTerminalRuntimeOptions {
  if (isAppleMobileBrowser(platform)) return { worker: false, renderer: 'auto' };
  return { worker: 'dedicated', renderer: 'auto' };
}

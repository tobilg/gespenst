import type { WasmerBrowserFeature, WasmerBrowserSupport } from './types.js';

/** Error thrown when the current page cannot initialize the Wasmer browser runtime. */
export class WasmerBrowserUnsupportedError extends Error {
  /** Stable error name for diagnostics and error-boundary filtering. */
  override readonly name = 'WasmerBrowserUnsupportedError';

  /** Browser capability report that caused initialization to fail. */
  readonly support: WasmerBrowserSupport;

  /** Creates an error for an unsupported browser capability report. */
  constructor(support: WasmerBrowserSupport) {
    super(
      `Wasmer requires browser features that are unavailable: ${support.missing.join(', ')}. ` +
        'Serve the page over HTTPS with Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp.'
    );
    this.support = support;
  }
}

/** Checks browser and isolation features required by `@wasmer/sdk`. */
export function getWasmerBrowserSupport(): WasmerBrowserSupport {
  const secureContext = globalThis.isSecureContext === true;
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const missing: WasmerBrowserFeature[] = [];
  if (!secureContext) missing.push('secure-context');
  if (!crossOriginIsolated) missing.push('cross-origin-isolation');
  if (typeof globalThis.SharedArrayBuffer === 'undefined') missing.push('shared-array-buffer');
  if (typeof globalThis.WebAssembly === 'undefined') missing.push('webassembly');
  if (typeof globalThis.Worker === 'undefined') missing.push('web-worker');
  if (
    typeof globalThis.ReadableStream === 'undefined' ||
    typeof globalThis.WritableStream === 'undefined'
  )
    missing.push('web-streams');
  return Object.freeze({
    supported: missing.length === 0,
    secureContext,
    crossOriginIsolated,
    missing: Object.freeze(missing),
  });
}

/** Throws a diagnostic error unless the current browser can run Wasmer. */
export function assertWasmerBrowserSupport(): WasmerBrowserSupport {
  const support = getWasmerBrowserSupport();
  if (!support.supported) throw new WasmerBrowserUnsupportedError(support);
  return support;
}

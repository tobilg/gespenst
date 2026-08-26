import { assertWasmerBrowserSupport } from './support.js';
import type { WasmerInitializationOptions } from './types.js';

export type WasmerSdk = typeof import('@wasmer/sdk');

let sdkPromise: Promise<WasmerSdk> | null = null;

/**
 * Initializes the process-wide Wasmer SDK. Repeated calls share one initialization; options from
 * the first call are used.
 */
export async function initializeWasmer(options: WasmerInitializationOptions = {}): Promise<void> {
  await loadWasmerSdk(options);
}

export function loadWasmerSdk(options: WasmerInitializationOptions = {}): Promise<WasmerSdk> {
  assertWasmerBrowserSupport();
  sdkPromise ??= import('@wasmer/sdk')
    .then(async (sdk) => {
      await sdk.init({
        ...(options.module === undefined ? {} : { module: options.module }),
        ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
        ...(options.sdkUrl === undefined ? {} : { sdkUrl: options.sdkUrl }),
        ...(options.registryUrl === undefined ? {} : { registryUrl: options.registryUrl }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
      return sdk;
    })
    .catch((error) => {
      sdkPromise = null;
      throw error;
    });
  return sdkPromise;
}

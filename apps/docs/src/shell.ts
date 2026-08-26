import type { GespenstTerminal } from '@gespenst/core';
import {
  getWasmerBrowserSupport,
  WasmerAddon,
  type WasmerBrowserSupport,
  WasmerBrowserUnsupportedError,
} from '@gespenst/wasmer';

/** Stage a demo reached before it failed, used to explain the failure in context. */
export type StartupPhase = 'browser' | 'terminal' | 'bash';

/** Reports progress to whatever status surface a page provides. */
export type StatusReporter = (text: string) => void;

export const wasmUrl = new URL('../../../packages/core/src/assets/ghostty-vt.wasm', import.meta.url)
  .href;
export const callbacksWasmUrl = new URL(
  '../../../packages/core/src/assets/ghostty-callbacks.wasm',
  import.meta.url
).href;

export function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

export function startupFailureTitle(phase: StartupPhase): string {
  if (phase === 'browser') return 'Browser setup failed';
  if (phase === 'terminal') return 'Terminal startup failed';
  return 'Bash startup failed';
}

export function formatStartupError(reason: unknown, phase: StartupPhase): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  const message = detail.trim() || startupFailureTitle(phase);
  if (reason instanceof WasmerBrowserUnsupportedError) return message;
  if (phase === 'terminal') {
    return (
      `${message}\n\n` +
      'The terminal worker failed to initialize. Reload the page. If this is a local docs server, ' +
      'restart pnpm docs:dev after rebuilding workspace packages.'
    );
  }
  if (phase === 'browser') return message;
  return (
    `${message}\n\n` +
    'The live demo downloads its Bash package from registry.wasmer.io and cdn.wasmer.io. ' +
    'Check content blockers or network policy, then select Retry Bash.'
  );
}

/** Starts the shared WASIX Bash session, retrying once before giving up. */
export async function startBash(
  terminal: GespenstTerminal,
  onStatus: StatusReporter
): Promise<Awaited<WasmerAddon['ready']>> {
  let failure: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const shell = new WasmerAddon({
      package: { type: 'registry', specifier: 'sharrattj/bash@1.0.17' },
      // Without coreutils the shell still resolves `ls` and friends on PATH, then fails to load
      // them with an unrelated-looking WASM instantiation error. Pinned like the bash package.
      uses: ['sharrattj/coreutils@1.0.16'],
      // WASIX exposes stdout and stderr as separate pipes with no shared ordering, so the shell
      // points both at one descriptor the way a PTY does. Without this, a prompt printed after
      // command output interleaves with it mid-line.
      args: ['-c', 'exec 2>&1; exec bash -i'],
      env: { PS1: 'bash \\$ ' },
    });
    terminal.loadAddon(shell);
    try {
      return await shell.ready;
    } catch (reason) {
      failure = reason;
      shell.dispose();
      if (attempt === 1) {
        onStatus(`${terminal.renderer.backend.toUpperCase()} · retrying Bash`);
        await delay(750);
      }
    }
  }
  throw failure;
}

/** Waits for the coi service worker to grant cross-origin isolation when the page lacks it. */
export async function ensureWasmerBrowserSupport(onStatus: StatusReporter): Promise<void> {
  const support = getWasmerBrowserSupport();
  if (support.supported) return;
  if (!canBootstrapIsolation(support)) throw new WasmerBrowserUnsupportedError(support);

  onStatus('Enabling browser isolation');
  await new Promise<void>((_resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new WasmerBrowserUnsupportedError(getWasmerBrowserSupport()));
    }, 8_000);
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        window.clearTimeout(timeout);
        window.location.reload();
      },
      { once: true }
    );
  });
}

function canBootstrapIsolation(support: WasmerBrowserSupport): boolean {
  if (!support.secureContext || !('serviceWorker' in navigator)) return false;
  return support.missing.every(
    (feature) => feature === 'cross-origin-isolation' || feature === 'shared-array-buffer'
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

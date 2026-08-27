import type { GespenstTerminal } from '@gespenst/core';
import {
  BrowserShellAddon,
  type BrowserShellBackend,
  type BrowserShellStatusEvent,
} from '@gespenst/shell';

/** Stage a demo reached before it failed, used to explain the failure in context. */
export type StartupPhase = 'browser' | 'terminal' | 'bash';

/** Reports progress to whatever status surface a page provides. */
export type StatusReporter = (text: string) => void;

export interface DemoShellReady {
  readonly session: { readonly exit: Promise<{ readonly code: number }> };
  readonly runtime: BrowserShellBackend;
  readonly label: string;
}

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
  if (phase === 'terminal') {
    return (
      `${message}\n\n` +
      'The terminal worker failed to initialize. Reload the page. If this is a local docs server, ' +
      'restart pnpm docs:dev after rebuilding workspace packages.'
    );
  }
  if (phase === 'browser') return message;
  return `${message}\n\nThe portable browser shell could not start. Reload the page and try again.`;
}

/** Starts the same portable browser-shell addon published for application use. */
export async function startBash(
  terminal: GespenstTerminal,
  onStatus: StatusReporter
): Promise<DemoShellReady> {
  const shell = new BrowserShellAddon({
    bashkit: {
      bash: {
        profile: 'interactive',
        username: 'guest',
        hostname: 'browser',
        cwd: '/home/guest',
        files: {
          '/home/guest/README.md':
            'Gespenst is rendering this single-threaded browser Bash session.\n',
          '/home/guest/hello.txt': 'Hello from a filesystem that lives entirely in this tab.\n',
        },
      },
    },
  });
  shell.onStatusChange((event) => reportShellStatus(terminal, event, onStatus));
  terminal.loadAddon(shell);
  const ready = await shell.ready;
  return {
    session: ready.session,
    runtime: ready.backend,
    label: 'BashKit WASM',
  };
}

function reportShellStatus(
  terminal: GespenstTerminal,
  event: BrowserShellStatusEvent,
  onStatus: StatusReporter
): void {
  if (event.status === 'starting') {
    onStatus(`${terminal.renderer.backend.toUpperCase()} · starting portable Bash`);
  }
}

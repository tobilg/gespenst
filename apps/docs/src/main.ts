import { ClipboardAddon } from '@gespenst/clipboard';
import { createTerminal, type GespenstTerminal, terminalColorToCss } from '@gespenst/core';
import '@gespenst/core/style.css';
import { type ThemeName, themeMetadata, themes } from '@gespenst/themes';
import { demoTerminalRuntime } from './demo-runtime';
import { installPageLifecycle } from './page-lifecycle';
import {
  callbacksWasmUrl,
  formatStartupError,
  requiredElement,
  type StartupPhase,
  startBash,
  startupFailureTitle,
  wasmUrl,
} from './shell';
import './style.css';

const host = requiredElement<HTMLElement>('#terminal');
const status = requiredElement<HTMLElement>('#renderer-status');
const reset = requiredElement<HTMLButtonElement>('#reset-demo');
const error = requiredElement<HTMLElement>('#terminal-error');
const themeSelect = requiredElement<HTMLSelectElement>('#theme-select');
let terminal: GespenstTerminal | null = null;
let startupFailed = false;
let startupPhase: StartupPhase = 'browser';
let pageTearingDown = false;
let activeShellLabel: string | null = null;

for (const name of Object.keys(themes) as ThemeName[]) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = themeMetadata[name].label;
  option.selected = name === 'gespenstDark';
  themeSelect.append(option);
}

applyStageBackground('gespenstDark');

themeSelect.addEventListener('change', () => {
  if (!terminal) return;
  const name = themeSelect.value as ThemeName;
  applyStageBackground(name);
  void terminal.setTheme(themes[name]).catch((reason: unknown) => showFailure(reason, 'terminal'));
});

reset.addEventListener('click', () => {
  if (startupFailed) window.location.reload();
  else clearDisplay();
});

installPageLifecycle({
  dispose: () => {
    pageTearingDown = true;
    terminal?.dispose();
  },
  restore: () => {
    terminal?.fit();
    terminal?.focus();
  },
});

try {
  startupPhase = 'terminal';
  const created = await createTerminal({
    container: host,
    ...demoTerminalRuntime(),
    accessibility: 'full',
    fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
    fontSizePx: 13,
    lineHeight: 1.35,
    theme: themes.gespenstDark,
    wasm: wasmUrl,
    callbacksWasm: callbacksWasmUrl,
  });
  if (pageTearingDown) {
    created.dispose();
    throw new Error('Page was unloaded during terminal startup');
  }
  terminal = created;
  terminal.on('renderer', ({ backend }) => {
    if (activeShellLabel) setStatus(`${backend.toUpperCase()} · ${activeShellLabel}`);
  });
  const clipboard = new ClipboardAddon({
    confirmUnsafePaste: ({ text }) =>
      window.confirm(`Paste text that may execute commands?\n\n${text}`),
    onError: (clipboardError) => console.error('[gespenst docs] Clipboard failed', clipboardError),
  });
  terminal.loadAddon(clipboard);
  await clipboard.ready;
  setStatus(`${terminal.renderer.backend.toUpperCase()} · starting Bash`);
  terminal.element.classList.add('docs-shell-starting');
  terminal.element.setAttribute('aria-busy', 'true');
  try {
    await terminal.writeAsync(
      '\x1b[38;2;208;138;63mgespenst\x1b[0m\r\n' + 'Starting a browser-only Bash session…\r\n\r\n'
    );

    startupPhase = 'bash';
    const { session, label } = await startBash(terminal, setStatus);
    activeShellLabel = label;
    setStatus(`${terminal.renderer.backend.toUpperCase()} · ${label}`);
    terminal.focus();
    void session.exit.then(
      ({ code }) => {
        if (!pageTearingDown) setStatus(`Bash exited · code ${code}`);
      },
      (reason: unknown) => {
        if (!pageTearingDown) showFailure(reason, 'bash');
      }
    );
  } finally {
    terminal.element.classList.remove('docs-shell-starting');
    terminal.element.removeAttribute('aria-busy');
  }
} catch (reason) {
  showFailure(reason, startupPhase);
}

function setStatus(text: string): void {
  if (pageTearingDown) return;
  status.textContent = text;
}

/** Keeps the padding gutter around the terminal on the active theme's background. */
function applyStageBackground(name: ThemeName): void {
  const background = themes[name].background;
  if (background === undefined) host.style.removeProperty('--terminal-canvas');
  else host.style.setProperty('--terminal-canvas', terminalColorToCss(background));
}

function clearDisplay(): void {
  if (!terminal) return;
  terminal.write('\x1b[2J\x1b[3J\x1b[H');
  terminal.focus();
}

function showFailure(reason: unknown, phase: StartupPhase): void {
  if (pageTearingDown) return;
  startupFailed = true;
  setStatus(startupFailureTitle(phase));
  reset.textContent = phase === 'bash' ? 'Retry Bash' : 'Reload demo';
  error.hidden = false;
  error.textContent = formatStartupError(reason, phase);
  console.error(`[gespenst docs] ${startupFailureTitle(phase)}`, reason);
}

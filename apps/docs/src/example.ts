import { createTerminal, type GespenstTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';
import { themes } from '@gespenst/themes';
import './style.css';
import './example.css';
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

const windowElement = requiredElement<HTMLElement>('#glass-window');
const titlebar = requiredElement<HTMLElement>('#glass-titlebar');
const host = requiredElement<HTMLElement>('#terminal');
const status = requiredElement<HTMLElement>('#renderer-status');
const error = requiredElement<HTMLElement>('#terminal-error');
let terminal: GespenstTerminal | null = null;
let startupPhase: StartupPhase = 'browser';
let pageTearingDown = false;
let activeShellLabel: string | null = null;

/**
 * The window carries the alpha on its background and keeps the text opaque black, so the gradient
 * and grid behind it read through the cells while the output stays legible.
 */
const glassTheme = {
  ...themes.gespenstLight,
  background: 'rgba(250, 248, 242, 0.06)',
  foreground: '#262722',
  cursor: '#262722',
  cursorAccent: 'rgba(250, 248, 242, 0.85)',
  selectionBackground: 'rgba(168, 95, 34, 0.22)',
};

makeDraggable();

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
    lineHeight: 1.4,
    // Init-only: it decides whether the rendering context is created with an alpha channel.
    allowTransparency: true,
    theme: glassTheme,
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
  setStatus(`${terminal.renderer.backend.toUpperCase()} · starting Bash`);
  terminal.element.classList.add('docs-shell-starting');
  terminal.element.setAttribute('aria-busy', 'true');
  try {
    await terminal.writeAsync('Starting a browser-only Bash session…\r\n\r\n');

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

function showFailure(reason: unknown, phase: StartupPhase): void {
  if (pageTearingDown) return;
  setStatus(startupFailureTitle(phase));
  error.hidden = false;
  error.textContent = formatStartupError(reason, phase);
  console.error(`[gespenst docs] ${startupFailureTitle(phase)}`, reason);
}

/**
 * Moves the window with a transform rather than by changing its box, so its size never changes and
 * the terminal is not remeasured mid-drag. Only the title bar starts a drag; the terminal body
 * keeps its own pointer handling for selection.
 */
function makeDraggable(): void {
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let dragging = false;

  // The stylesheet owns the transform and reads these, so the stacked narrow layout can drop
  // the offset with an ordinary rule instead of having to outrank an inline style.
  const apply = () => {
    windowElement.style.setProperty('--drag-x', `${x}px`);
    windowElement.style.setProperty('--drag-y', `${y}px`);
  };

  /** Keeps a grabbable strip of the window on screen at any viewport size. */
  const clamp = () => {
    const margin = 24;
    const bounds = windowElement.getBoundingClientRect();
    const left = bounds.left - x;
    const top = bounds.top - y;
    const minX = margin - left - bounds.width + margin;
    const maxX = window.innerWidth - left - margin;
    const minY = margin - top;
    const maxY = window.innerHeight - top - margin;
    x = Math.min(Math.max(x, minX), maxX);
    y = Math.min(Math.max(y, minY), maxY);
  };

  // Below this width the window is a static block in the flow, so there is nothing to drag.
  const floating = window.matchMedia('(min-width: 1101px)');

  titlebar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !floating.matches) return;
    dragging = true;
    startX = event.clientX - x;
    startY = event.clientY - y;
    titlebar.setPointerCapture(event.pointerId);
    windowElement.classList.add('is-dragging');
    event.preventDefault();
  });

  titlebar.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    x = event.clientX - startX;
    y = event.clientY - startY;
    clamp();
    apply();
  });

  const end = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (titlebar.hasPointerCapture(event.pointerId))
      titlebar.releasePointerCapture(event.pointerId);
    windowElement.classList.remove('is-dragging');
  };
  titlebar.addEventListener('pointerup', end);
  titlebar.addEventListener('pointercancel', end);

  // Keyboard nudging, so the window is movable without a pointer.
  titlebar.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 32 : 8;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move || !floating.matches) return;
    x += move[0];
    y += move[1];
    clamp();
    apply();
    event.preventDefault();
  });

  window.addEventListener('resize', () => {
    clamp();
    apply();
  });
}

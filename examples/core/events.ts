import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';

const terminal = await createTerminal({
  container: requiredElement<HTMLElement>('#terminal'),
});

// #region geometry
const resizeSubscription = terminal.on('resize', (geometry) => {
  updatePtySize(geometry.cols, geometry.rows);
});

updatePtySize(terminal.geometry.cols, terminal.geometry.rows);
// #endregion geometry

// #region policy
const clipboardSubscription = terminal.on('clipboardWrite', (request) => {
  // Gespenst denies remote writes in 0.1.0. This event is an audit record only.
  console.info('Blocked terminal clipboard write', {
    location: request.location,
    name: request.name,
    mimeTypes: request.contents.map(({ mime }) => mime),
  });
});

const notificationSubscription = terminal.on('notification', ({ title, body }) => {
  if (document.visibilityState === 'hidden' && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
});
// #endregion policy

// #region lifecycle
let restoreTerminalFocus = false;

window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    restoreTerminalFocus = terminal.element.contains(document.activeElement);
  } else {
    resizeSubscription.dispose();
    clipboardSubscription.dispose();
    notificationSubscription.dispose();
    terminal.dispose();
  }
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  terminal.fit();
  if (restoreTerminalFocus) terminal.focus();
});
// #endregion lifecycle

function updatePtySize(cols: number, rows: number): void {
  console.info('Send terminal geometry to the PTY', { cols, rows });
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

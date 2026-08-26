import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';

// #region setup
const host = requiredElement<HTMLElement>('#terminal');

const terminal = await createTerminal({
  container: host,
  worker: 'dedicated',
  renderer: 'auto',
  accessibility: 'basic',
});

terminal.write('\x1b[1;32mgespenst is ready\x1b[0m\r\n');
terminal.focus();

window.addEventListener('beforeunload', () => terminal.dispose(), { once: true });
// #endregion setup

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

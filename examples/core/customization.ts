import { createTerminal, type TerminalTheme } from '@gespenst/core';
import '@gespenst/core/style.css';

const duskTheme: TerminalTheme = {
  appearance: 'dark',
  foreground: { r: 229, g: 231, b: 225 },
  background: { r: 22, g: 25, b: 21 },
  cursor: { r: 208, g: 138, b: 63 },
  cursorAccent: '#161915',
  selectionBackground: 'rgba(208, 138, 63, 0.35)',
  red: '#dc6259',
  green: '#92b45d',
  yellow: '#d6ad60',
  blue: '#6f9fc0',
  magenta: '#a786b8',
  cyan: '#65aaa4',
};

// #region appearance
const terminal = await createTerminal({
  container: requiredElement<HTMLElement>('#terminal'),
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSizePx: 14,
  lineHeight: 1.25,
  theme: duskTheme,
});

await terminal.loadFont({
  family: 'JetBrains Mono',
  source: 'url(/fonts/jetbrains-mono.woff2)',
  descriptors: { weight: '400 700' },
});

await terminal.setFont({ family: 'JetBrains Mono, ui-monospace, monospace' });
await terminal.updateTheme({ cursor: '#f5d08a' });
// #endregion appearance

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

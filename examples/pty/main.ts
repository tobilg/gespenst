import { createTerminal } from '../../packages/core/src';
import { WebSocketAddon } from '../../packages/websocket/src';

const container = requiredElement<HTMLElement>('#terminal');
const status = requiredElement<HTMLElement>('#status');
const reconnect = requiredElement<HTMLButtonElement>('#reconnect');

const terminal = await createTerminal({
  container,
  fontFamily:
    '"Source Code Pro for Powerline", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSizePx: 14,
  accessibility: 'full',
});

let transport: WebSocketAddon | null = null;

terminal.on('title', (title) => {
  document.title = title ? `${title} · gespenst` : 'gespenst · PTY example';
});

reconnect.addEventListener('click', () => void connect());
window.addEventListener('beforeunload', () => terminal.dispose());

await connect();

async function connect(): Promise<void> {
  transport?.dispose();
  transport = null;
  setStatus('connecting', 'Authenticating');
  reconnect.disabled = true;

  try {
    const response = await fetch('/api/terminal-token', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Token request failed with status ${response.status}`);
    const body = (await response.json()) as { readonly token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0)
      throw new Error('Token response did not contain a token');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL('/ws', `${protocol}//${location.host}`);
    url.searchParams.set('token', body.token);

    const addon = new WebSocketAddon(url, { reconnect: false });
    transport = addon;
    addon.onStatusChange((state) => {
      if (state === 'connected') {
        setStatus('connected', 'Connected');
        terminal.focus();
      } else if (state === 'closed' || state === 'error') {
        setStatus('disconnected', state === 'error' ? 'Connection error' : 'Disconnected');
        reconnect.disabled = false;
      }
    });
    terminal.loadAddon(addon);
    await addon.ready;
  } catch (error) {
    console.error(error);
    setStatus('disconnected', 'Connection failed');
    reconnect.disabled = false;
  }
}

function setStatus(state: 'connecting' | 'connected' | 'disconnected', label: string): void {
  status.dataset.state = state;
  status.textContent = label;
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required example element: ${selector}`);
  return element;
}

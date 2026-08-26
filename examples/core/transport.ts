import { createTerminal, type TerminalTransport } from '@gespenst/core';
import '@gespenst/core/style.css';

// #region connect
const terminal = await createTerminal({
  container: requiredElement<HTMLElement>('#terminal'),
});

const socket = new WebSocket('wss://terminal.example.test/session');
socket.binaryType = 'arraybuffer';
await waitForOpen(socket);

const connection = terminal.connect(socketTransport(socket));

const resizeSubscription = terminal.on('resize', ({ cols, rows }) => {
  socket.send(JSON.stringify({ type: 'resize', cols, rows }));
});

connection.closed.finally(() => {
  resizeSubscription.dispose();
  terminal.dispose();
});
// #endregion connect

// #region adapter
function socketTransport(socket: WebSocket): TerminalTransport {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(event.data));
        }
      });
      socket.addEventListener('close', () => controller.close(), { once: true });
      socket.addEventListener(
        'error',
        () => controller.error(new Error('Terminal WebSocket failed')),
        { once: true }
      );
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(data) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Terminal WebSocket is not open');
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      socket.send(copy.buffer);
    },
    close() {
      socket.close(1000, 'Terminal input closed');
    },
  });

  return { readable, writable };
}
// #endregion adapter

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
      once: true,
    });
  });
}

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

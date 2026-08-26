import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty, { type IPty } from '@lydell/node-pty';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import WebSocket, { type RawData, WebSocketServer } from 'ws';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 65_535;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 1024 * 1024;
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = parsePort(process.env.PORT ?? '5174');
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = randomBytes(32).toString('base64url');

if (!isLoopbackHostname(HOST)) {
  throw new Error('The PTY example only binds to localhost, 127.0.0.1, or ::1');
}

interface ResizeControl {
  readonly type: 'resize';
  readonly cols: number;
  readonly rows: number;
}

interface HelloControl {
  readonly type: 'hello';
  readonly version: 1;
  readonly cols: number;
  readonly rows: number;
}

interface PtySession {
  readonly terminal: IPty;
  readonly socket: WebSocket;
  closed: boolean;
  paused: boolean;
}

const sessions = new Set<PtySession>();
let vite: ViteDevServer | undefined;

const server = createServer((request, response) => {
  handleHttp(request, response);
});

vite = await createViteServer({
  root: PROJECT_ROOT,
  configFile: false,
  appType: 'spa',
  server: {
    middlewareMode: true,
    hmr: { server },
  },
});

const sockets = new WebSocketServer({
  noServer: true,
  clientTracking: false,
  perMessageDeflate: false,
  maxPayload: MAX_MESSAGE_BYTES,
});

server.on('upgrade', (request, socket, head) => {
  const url = requestUrl(request);
  if (!url || url.pathname !== '/ws') return;
  if (!isAllowedHost(request.headers.host)) {
    rejectUpgrade(socket, 403, 'Forbidden host');
    return;
  }
  if (!isSameOrigin(request.headers.origin, request.headers.host)) {
    rejectUpgrade(socket, 403, 'Forbidden origin');
    return;
  }
  if (!matchesToken(url.searchParams.get('token'))) {
    rejectUpgrade(socket, 401, 'Invalid terminal token');
    return;
  }

  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit('connection', webSocket, request);
  });
});

sockets.on('connection', (socket, request) => {
  const url = requestUrl(request);
  if (!url) {
    socket.close(1008, 'Invalid request');
    return;
  }

  const cols = parseDimension(url.searchParams.get('cols'), DEFAULT_COLS);
  const rows = parseDimension(url.searchParams.get('rows'), DEFAULT_ROWS);
  let terminal: IPty;
  try {
    terminal = createPty(cols, rows);
  } catch (error) {
    console.error('Failed to start PTY:', error);
    socket.close(1011, 'Failed to start PTY');
    return;
  }

  const session: PtySession = { terminal, socket, closed: false, paused: false };
  sessions.add(session);
  const decoder = new TextDecoder();

  terminal.onData((data) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount >= MAX_SOCKET_BUFFER_BYTES && !session.paused) {
      terminal.pause();
      session.paused = true;
    }
    socket.send(Buffer.from(data, 'utf8'), { binary: true }, (error) => {
      if (error) {
        closeSession(session);
        return;
      }
      if (session.paused && socket.bufferedAmount < MAX_SOCKET_BUFFER_BYTES / 4) {
        terminal.resume();
        session.paused = false;
      }
    });
  });

  terminal.onExit(({ exitCode }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, `Shell exited with status ${exitCode}`);
    }
    closeSession(session, false);
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      terminal.write(decoder.decode(rawDataBytes(data), { stream: true }));
      return;
    }
    const control = parseControl(rawDataBytes(data).toString('utf8'));
    if (!control) {
      socket.close(1003, 'Invalid control message');
      return;
    }
    terminal.resize(control.cols, control.rows);
  });

  socket.on('close', () => closeSession(session));
  socket.on('error', () => closeSession(session));
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(PORT, HOST, () => {
    server.off('error', rejectListen);
    resolveListen();
  });
});

console.log(`gespenst PTY example: http://${displayHost(HOST)}:${PORT}/examples/pty/`);
console.log(`Shell: ${shellPath()} · cwd: ${process.env.PTY_CWD ?? homedir()}`);
console.log('The server is loopback-only. Press Ctrl+C to stop it.');

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const session of [...sessions]) closeSession(session);
  sockets.close();
  await vite?.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  if (!isAllowedHost(request.headers.host)) {
    writeResponse(response, 403, 'Forbidden host');
    return;
  }
  const url = requestUrl(request);
  if (!url) {
    writeResponse(response, 400, 'Bad Request');
    return;
  }
  if (url.pathname === '/api/terminal-token') {
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      writeResponse(response, 405, 'Method Not Allowed');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify({ token: TOKEN }));
    return;
  }
  if (url.pathname === '/') {
    response.writeHead(302, { Location: '/examples/pty/' });
    response.end();
    return;
  }
  if (!vite) {
    writeResponse(response, 503, 'Vite is starting');
    return;
  }
  vite.middlewares(request, response, () => writeResponse(response, 404, 'Not Found'));
}

function createPty(cols: number, rows: number): IPty {
  return pty.spawn(shellPath(), [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.PTY_CWD ?? homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'gespenst',
      TERM_PROGRAM_VERSION: process.env.npm_package_version ?? 'development',
    },
  });
}

function shellPath(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

function parseControl(value: string): ResizeControl | HelloControl | null {
  try {
    const parsed = JSON.parse(value) as {
      readonly type?: unknown;
      readonly version?: unknown;
      readonly cols?: unknown;
      readonly rows?: unknown;
    };
    if (parsed.type !== 'resize' && parsed.type !== 'hello') return null;
    if (!validDimension(parsed.cols) || !validDimension(parsed.rows)) return null;
    if (parsed.type === 'hello') {
      if (parsed.version !== 1) return null;
      return { type: 'hello', version: 1, cols: parsed.cols, rows: parsed.rows };
    }
    return { type: 'resize', cols: parsed.cols, rows: parsed.rows };
  } catch {
    return null;
  }
}

function validDimension(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_DIMENSION;
}

function parseDimension(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return validDimension(parsed) ? parsed : fallback;
}

function rawDataBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function closeSession(session: PtySession, kill = true): void {
  if (session.closed) return;
  session.closed = true;
  sessions.delete(session);
  if (kill) {
    try {
      session.terminal.kill();
    } catch {
      // The process may have already exited.
    }
  }
  if (session.socket.readyState === WebSocket.OPEN) session.socket.close(1001, 'Session closed');
}

function requestUrl(request: IncomingMessage): URL | null {
  if (!request.headers.host) return null;
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host}`);
  } catch {
    return null;
  }
}

function isAllowedHost(authority: string | undefined): boolean {
  if (!authority) return false;
  try {
    const url = new URL(`http://${authority}`);
    const port = url.port ? Number(url.port) : 80;
    return isLoopbackHostname(url.hostname) && port === PORT;
  } catch {
    return false;
  }
}

function isSameOrigin(origin: string | undefined, authority: string | undefined): boolean {
  if (!origin || !authority) return false;
  try {
    return new URL(origin).origin === new URL(`http://${authority}`).origin;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function matchesToken(candidate: string | null): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(TOKEN);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
}

function writeResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535, received ${value}`);
  }
  return port;
}

function displayHost(hostname: string): string {
  return hostname.includes(':') ? `[${hostname.replace(/^\[|\]$/g, '')}]` : hostname;
}

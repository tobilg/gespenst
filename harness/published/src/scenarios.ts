import ibmPlexMonoUrl from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url';
import { createBashKitShell } from '@gespenst/bashkit';
import { ClipboardAddon } from '@gespenst/clipboard';
import { type BrowserTerminal, createTerminal } from '@gespenst/core';
import { GespenstTerminal as ReactTerminal } from '@gespenst/react';
import { SearchAddon as NativeSearchAddon } from '@gespenst/search';
import { SerializeAddon as NativeSerializeAddon } from '@gespenst/serialize';
import { BrowserShellAddon } from '@gespenst/shell';
import { gespenstTerminal } from '@gespenst/svelte';
import { themes } from '@gespenst/themes';
import { dracula } from '@gespenst/themes/dracula';
import { GespenstTerminal as VueTerminal } from '@gespenst/vue';
import { WebFontsAddon } from '@gespenst/web-fonts';
import { WebLinksAddon as NativeWebLinksAddon } from '@gespenst/web-links';
import { WebSocketAddon } from '@gespenst/websocket';
import { Terminal as GespenstXterm } from '@gespenst/xterm';
import { AttachAddon } from '@xterm/addon-attach';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon as XtermSearchAddon } from '@xterm/addon-search';
import { SerializeAddon as XtermSerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon as XtermWebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as UpstreamXterm } from '@xterm/xterm';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createApp } from 'vue';
import type { FunctionalReport, ScenarioResult } from './types.js';

export interface ScenarioEnvironment {
  readonly websocketToken: string;
  createHost(id: string, label: string): HTMLElement;
  update(id: string, status: 'running' | 'passed' | 'failed', details?: string): void;
  log(message: string): void;
}

type Cleanup = () => void | Promise<void>;
type Scenario = (
  host: HTMLElement,
  environment: ScenarioEnvironment
) => Promise<Record<string, unknown>>;

const activeCleanups: Cleanup[] = [];

const scenarios: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly run: Scenario;
}> = [
  { id: 'native-addons', label: 'Native core and addons', run: nativeAddonScenario },
  { id: 'browser-shell', label: 'Browser-only Bash', run: browserShellScenario },
  { id: 'websocket-mock', label: 'WebSocket protocol', run: websocketMockScenario },
  { id: 'real-pty', label: 'Real local PTY', run: realPtyScenario },
  { id: 'xterm-compatibility', label: 'xterm.js compatibility', run: xtermCompatibilityScenario },
  { id: 'framework-bindings', label: 'Framework bindings', run: frameworkScenario },
];

export async function runFunctionalScenarios(
  environment: ScenarioEnvironment
): Promise<FunctionalReport> {
  await disposeActiveScenarios();
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  let renderer: string | null = null;
  for (const scenario of scenarios) {
    const host = environment.createHost(scenario.id, scenario.label);
    environment.update(scenario.id, 'running');
    environment.log(`Starting ${scenario.label}`);
    const start = performance.now();
    try {
      const details = await withTimeout(
        scenario.run(host, environment),
        scenario.id === 'browser-shell' ? 30_000 : 20_000,
        scenario.label
      );
      if (typeof details.renderer === 'string') renderer = details.renderer;
      const durationMs = round(performance.now() - start);
      results.push({
        id: scenario.id,
        label: scenario.label,
        status: 'passed',
        durationMs,
        details,
      });
      environment.update(scenario.id, 'passed', formatDetails(details, durationMs));
      environment.log(`Passed ${scenario.label} in ${durationMs} ms`);
    } catch (reason) {
      const durationMs = round(performance.now() - start);
      const error = errorMessage(reason);
      results.push({
        id: scenario.id,
        label: scenario.label,
        status: 'failed',
        durationMs,
        details: {},
        error,
      });
      environment.update(scenario.id, 'failed', error);
      environment.log(`Failed ${scenario.label}: ${error}`);
    }
  }
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    renderer,
    scenarios: results,
  };
}

export async function disposeActiveScenarios(): Promise<void> {
  for (const cleanup of activeCleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Cleanup must not hide the next diagnostic run.
    }
  }
}

async function nativeAddonScenario(
  host: HTMLElement,
  environment: ScenarioEnvironment
): Promise<Record<string, unknown>> {
  const terminal = await createTerminal({
    container: host,
    renderer: 'auto',
    worker: false,
    scrollbackLines: 2_000,
    accessibility: 'full',
  });
  activeCleanups.push(() => terminal.dispose());

  const search = new NativeSearchAddon({ refreshDebounceMs: 0 });
  let searchResult: unknown;
  search.onDidChangeResults((result) => {
    searchResult = result;
  });
  const serialize = new NativeSerializeAddon();
  const clipboard = new ClipboardAddon();
  const fonts = new WebFontsAddon();
  let activatedLink = '';
  const links = new NativeWebLinksAddon({
    requireModifier: false,
    activate: (_event, uri) => {
      activatedLink = uri;
    },
  });
  for (const addon of [search, serialize, clipboard, fonts, links]) terminal.loadAddon(addon);
  await clipboard.ready;

  const input = onceInput(terminal);
  terminal.sendText('typed-from-harness');
  assert((await input) === 'typed-from-harness', 'Core input did not round-trip');

  const output = Array.from(
    { length: 72 },
    (_, index) =>
      `\u001b[38;2;${80 + (index % 80)};180;130mrow ${String(index).padStart(3, '0')}\u001b[0m ` +
      `${index === 55 ? 'needlewide 界🙂 e\u0301' : 'payload'}\r\n`
  ).join('');
  await terminal.writeAsync(`${output}https://example.com/gespenst\r\n`);
  environment.log('Native output and renderer boundary passed');
  const bufferState = await terminal.readBuffer({ start: 0, end: 0 });
  const retained = await terminal.readBuffer({ start: 0, end: bufferState.state.totalRows });
  const found = await search.findNext('needlewide');
  assert(
    found,
    `Full-buffer search failed (rows=${retained.rows.length}, retained=${retained.rows.some((row) => row.text.includes('needlewide'))}, result=${JSON.stringify(searchResult)})`
  );
  assert(search.getMatch(0)?.text === 'needlewide', 'Search result text was incorrect');
  environment.log('Retained-buffer search passed');

  terminal.scrollToBottom();
  await links.refresh();
  const link = terminal.element.querySelector<HTMLAnchorElement>('.gespenst__link');
  assert(link?.href.includes('example.com/gespenst'), 'Web link overlay was not created');
  link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  assert(activatedLink === 'https://example.com/gespenst', 'Web link activation was not forwarded');
  environment.log('Web link detection and activation passed');

  const pasted = onceInput(terminal);
  dispatchPaste(terminal.element, 'clipboard paste');
  assert(
    (await withTimeout(pasted, 2_000, 'clipboard input')) === 'clipboard paste',
    'Clipboard paste did not reach terminal input'
  );
  environment.log('Clipboard input passed');

  const snapshot = await serialize.serialize({ createdAt: new Date('2026-01-01T00:00:00Z') });
  await terminal.writeAsync('MUTATION_AFTER_SNAPSHOT');
  await serialize.restore(snapshot);
  const restored = await retainedBufferText(terminal);
  assert(restored.includes('needlewide'), 'Serialized terminal did not restore retained text');
  assert(!restored.includes('MUTATION_AFTER_SNAPSHOT'), 'Restore retained post-snapshot output');
  environment.log('Serialization round-trip passed');

  await terminal.setTheme(dracula);
  assert(Object.keys(themes).length >= 12, 'Theme registry is incomplete');
  environment.log('Theme registry and update passed');
  environment.log('Loading the WOFF2 fixture through WebFontsAddon');
  await fonts.load(
    [
      {
        family: 'Gespenst Harness Mono',
        source: `url(${JSON.stringify(ibmPlexMonoUrl)}) format("woff2")`,
      },
    ],
    { family: 'Gespenst Harness Mono, monospace' }
  );
  environment.log('Web font load passed');
  const beforeFit = terminal.geometry;
  terminal.resize(40, 8);
  assert(terminal.geometry.cols === 40 && terminal.geometry.rows === 8, 'Explicit resize failed');
  terminal.fit();
  assert(terminal.geometry.cols > 0 && terminal.geometry.rows > 0, 'Fit produced invalid geometry');
  const viewport = await terminal.readViewport();
  assert(viewport.viewportRows.length > 0, 'Viewport read returned no rows');

  return {
    renderer: terminal.renderer.backend,
    shaping: terminal.renderer.textShaping,
    searchMatches: 1,
    snapshotBytes: snapshot.byteLength,
    initialGrid: `${beforeFit.cols}×${beforeFit.rows}`,
    fittedGrid: `${terminal.geometry.cols}×${terminal.geometry.rows}`,
    themeCount: Object.keys(themes).length,
  };
}

async function browserShellScenario(host: HTMLElement): Promise<Record<string, unknown>> {
  const lowLevel = await createBashKitShell({
    prompt: 'direct $ ',
    bash: {
      cwd: '/home/guest',
      files: { '/home/guest/direct.txt': 'direct session\n' },
    },
  });
  const directReader = lowLevel.transport.readable.getReader();
  const directWriter = lowLevel.transport.writable.getWriter();
  const directPrompt = new TextDecoder().decode((await directReader.read()).value);
  assert(directPrompt === 'direct $ ', 'Direct BashKit prompt was incorrect');
  await directWriter.write(new TextEncoder().encode('pwd\r'));
  const directOutput = await readThroughPrompt(directReader, 'direct $ ');
  assert(directOutput.includes('/home/guest\r\n'), 'Direct BashKit command failed');
  directReader.releaseLock();
  directWriter.releaseLock();
  lowLevel.dispose();

  const terminal = await createTerminal({
    container: host,
    renderer: 'auto',
    worker: false,
    cols: 72,
    rows: 12,
    scrollbackLines: 1_000,
  });
  activeCleanups.push(() => terminal.dispose());
  const shell = new BrowserShellAddon({
    bashkit: {
      prompt: 'harness $ ',
      bash: {
        cwd: '/home/guest',
        files: {
          '/home/guest/README.md': 'published harness\n',
          '/tmp/inside.txt': 'stateful cd\n',
        },
      },
    },
  });
  terminal.loadAddon(shell);
  const ready = await shell.ready;
  await waitForTerminalText(terminal, 'harness $ ', 15_000);

  await submitShellCommand(terminal, 'pwd', '/home/guest');
  await submitShellCommand(terminal, 'cd /tmp && pwd', '/tmp');
  await submitShellCommand(terminal, 'ls -la', 'inside.txt');
  await submitShellCommand(terminal, 'printf "alpha\\nbeta\\n" | tail -n 1', 'beta');
  await submitShellCommand(terminal, 'definitely-missing-command', 'command not found');
  const failureText = await bufferText(terminal);
  assert(
    /command not found\s+harness \$ /u.test(failureText),
    'Missing-command output did not place the next prompt on a new line'
  );

  const textarea = terminal.element.querySelector<HTMLTextAreaElement>('textarea');
  assert(textarea, 'Terminal textarea was not created');
  const mobileInput = onceInput(terminal);
  textarea.focus();
  submitMobileInput(textarea, 'echo __MOBILE_INPUT_OK__');
  const mobileBytes = await withTimeout(mobileInput, 2_000, 'mobile textarea input');
  assert(
    mobileBytes === 'echo __MOBILE_INPUT_OK__\r',
    `Mobile textarea encoded ${JSON.stringify(mobileBytes)} incorrectly`
  );
  try {
    await waitForTerminalText(terminal, '__MOBILE_INPUT_OK__');
  } catch (error) {
    throw new Error(
      `${errorMessage(error)} (input=${JSON.stringify(mobileBytes)}, connection=${ready.connection.status}, session=${ready.session.status}, shell=${shell.status}, buffer=${JSON.stringify(await bufferText(terminal))})`
    );
  }
  const mobileOutput = await bufferText(terminal);
  assert(
    mobileOutput.includes('__MOBILE_INPUT_OK__'),
    'Mobile textarea input did not execute in the shell'
  );

  return {
    backend: ready.backend,
    renderer: terminal.renderer.backend,
    filesystem: ready.session.capabilities.filesystem,
    subprocesses: ready.session.capabilities.subprocesses,
    mobileInput: true,
  };
}

async function websocketMockScenario(
  host: HTMLElement,
  environment: ScenarioEnvironment
): Promise<Record<string, unknown>> {
  const terminal = await createTerminal({
    container: host,
    renderer: 'canvas2d',
    worker: false,
    cols: 64,
    rows: 10,
  });
  activeCleanups.push(() => terminal.dispose());
  const url = websocketUrl('/ws/mock', environment.websocketToken);
  const statuses: string[] = [];
  const addon = new WebSocketAddon(url, { reconnect: false });
  addon.onStatusChange((status) => statuses.push(status));
  terminal.loadAddon(addon);
  const connection = await addon.ready;
  await waitForTerminalText(terminal, 'mock-ready');
  terminal.sendText('ping');
  await waitForTerminalText(terminal, 'mock:ping');
  terminal.resize(91, 27);
  await waitForTerminalText(terminal, 'mock-resize 91x27');
  terminal.sendText('exit-mock');
  await connection.closed;
  await waitFor(() => addon.status === 'closed', 5_000, 'mock WebSocket close');
  return { statuses, connection: connection.status, binaryTransport: true };
}

async function realPtyScenario(
  host: HTMLElement,
  environment: ScenarioEnvironment
): Promise<Record<string, unknown>> {
  const terminal = await createTerminal({
    container: host,
    renderer: 'canvas2d',
    worker: false,
    cols: 70,
    rows: 14,
    scrollbackLines: 500,
  });
  activeCleanups.push(() => terminal.dispose());
  const addon = new WebSocketAddon(websocketUrl('/ws/pty', environment.websocketToken), {
    reconnect: false,
  });
  terminal.loadAddon(addon);
  const connection = await addon.ready;
  await delay(100);
  terminal.sendText("printf '__PTY_RESULT_%s__\\n' $((21*2))\r");
  await waitForTerminalText(terminal, '__PTY_RESULT_42__', 10_000);
  terminal.resize(83, 19);
  terminal.sendText("printf '__PTY_SIZE__'; stty size\r");
  await waitForTerminalText(terminal, '19 83', 10_000);
  terminal.sendText('exit\r');
  await connection.closed;
  return { command: true, resize: '83×19', status: connection.status };
}

async function xtermCompatibilityScenario(
  host: HTMLElement,
  environment: ScenarioEnvironment
): Promise<Record<string, unknown>> {
  const compatibilityHost = document.createElement('div');
  compatibilityHost.className = 'terminal-host';
  compatibilityHost.style.height = '150px';
  host.replaceChildren(compatibilityHost);
  const terminal = new GespenstXterm({
    cols: 36,
    rows: 6,
    scrollback: 100,
    allowProposedApi: true,
  });
  activeCleanups.push(() => terminal.dispose());
  const queued = writeXterm(terminal, 'queued before open\r\n');
  terminal.open(compatibilityHost);
  await terminal.ready;
  await queued;
  const fit = new FitAddon();
  const search = new XtermSearchAddon();
  const serialize = new XtermSerializeAddon();
  let link = '';
  const webLinks = new XtermWebLinksAddon((_event, uri) => {
    link = uri;
  });
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(serialize);
  terminal.loadAddon(webLinks);
  await writeXterm(terminal, '\u001b[31mcompat output\u001b[0m https://example.com\r\nsecond line');
  assert(
    terminal.buffer.active.getLine(0)?.translateToString(true).includes('queued before open'),
    'Compatibility buffer lost queued output'
  );
  assert(fit.proposeDimensions(), 'Fit addon did not propose dimensions');
  fit.fit();
  assert(search.findNext('compat output'), 'Search addon did not find compatibility output');
  assert(serialize.serialize().includes('compat output'), 'Serialize addon omitted output');

  const socket = new WebSocket(websocketUrl('/ws/attach', environment.websocketToken));
  await waitForSocket(socket);
  const attach = new AttachAddon(socket);
  terminal.loadAddon(attach);
  let parsedWrites = 0;
  const parsedSubscription = terminal.onWriteParsed(() => {
    parsedWrites += 1;
  });
  await writeXterm(terminal, '');
  await waitFor(
    () => xtermBufferText(terminal).includes('attach-ready'),
    5_000,
    'xterm attach output'
  );
  terminal.input('attach-outbound');
  try {
    await waitFor(
      () => xtermBufferText(terminal).replaceAll('\n', '').includes('attach:attach-outbound'),
      5_000,
      'xterm attach echo'
    );
  } catch (error) {
    throw new Error(
      `${errorMessage(error)} (parsedWrites=${parsedWrites}, buffer=${JSON.stringify(xtermBufferText(terminal))})`
    );
  } finally {
    parsedSubscription.dispose();
  }
  socket.close(1000, 'done');

  const upstreamHost = document.createElement('div');
  upstreamHost.style.cssText = 'position:absolute;width:480px;height:180px;left:-10000px;top:0';
  document.body.append(upstreamHost);
  const upstream = new UpstreamXterm({ cols: 36, rows: 6, scrollback: 100 });
  upstream.open(upstreamHost);
  await writeXterm(upstream, 'upstream xterm baseline');
  assert(
    upstream.buffer.active.getLine(0)?.translateToString(true).includes('upstream xterm'),
    'Upstream xterm.js baseline failed'
  );
  upstream.dispose();
  upstreamHost.remove();

  return {
    cols: terminal.cols,
    rows: terminal.rows,
    renderer: (await terminal.native).renderer.backend,
    officialAddons: ['fit', 'search', 'serialize', 'web-links', 'attach'],
    linkProviderLoaded: link === '' || link.startsWith('http'),
  };
}

async function frameworkScenario(host: HTMLElement): Promise<Record<string, unknown>> {
  const frameworkHost = document.createElement('div');
  frameworkHost.style.cssText =
    'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;height:210px';
  host.replaceChildren(frameworkHost);
  const reactHost = frameworkCell(frameworkHost, 'React');
  const vueHost = frameworkCell(frameworkHost, 'Vue');
  const svelteHost = frameworkCell(frameworkHost, 'Svelte');

  const reactReady = deferred<BrowserTerminal>();
  const reactRoot = createRoot(reactHost);
  reactRoot.render(
    createElement(ReactTerminal, {
      renderer: 'canvas2d',
      worker: false,
      cols: 18,
      rows: 4,
      onReady: reactReady.resolve,
      onTerminalError: reactReady.reject,
    })
  );
  const reactTerminal = await reactReady.promise;
  await reactTerminal.writeAsync('React ready');
  const firstReact = reactTerminal;
  reactRoot.render(
    createElement(ReactTerminal, {
      renderer: 'canvas2d',
      worker: false,
      cols: 18,
      rows: 4,
      onReady: () => undefined,
    })
  );
  await delay(0);
  assert(
    (await bufferText(firstReact)).includes('React ready'),
    'React callback update recreated the terminal'
  );

  const vueReady = deferred<BrowserTerminal>();
  const vueApp = createApp(VueTerminal, {
    options: { renderer: 'canvas2d', worker: false, cols: 18, rows: 4 },
    onReady: vueReady.resolve,
    onError: vueReady.reject,
  });
  vueApp.mount(vueHost);
  const vueTerminal = await vueReady.promise;
  await vueTerminal.writeAsync('Vue ready');

  const svelteReady = deferred<BrowserTerminal>();
  const action = gespenstTerminal(svelteHost, {
    renderer: 'canvas2d',
    worker: false,
    cols: 18,
    rows: 4,
    onReady: svelteReady.resolve,
    onError: svelteReady.reject,
  });
  const svelteTerminal = await svelteReady.promise;
  action.update({
    renderer: 'canvas2d',
    worker: false,
    cols: 18,
    rows: 4,
    fontSizePx: 13,
    theme: dracula,
  });
  await svelteTerminal.writeAsync('Svelte ready');

  assert((await bufferText(vueTerminal)).includes('Vue ready'), 'Vue terminal output failed');
  assert(
    (await bufferText(svelteTerminal)).includes('Svelte ready'),
    'Svelte terminal output failed'
  );
  reactRoot.unmount();
  vueApp.unmount();
  action.destroy();
  await delay(0);
  assert(reactHost.childElementCount === 0, 'React unmount retained terminal DOM');
  assert(vueHost.childElementCount === 0, 'Vue unmount retained terminal DOM');
  assert(svelteHost.childElementCount === 0, 'Svelte destroy retained terminal DOM');
  return { react: true, vue: true, svelte: true, disposal: true };
}

function onceInput(terminal: BrowserTerminal): Promise<string> {
  return new Promise((resolve) => {
    const subscription = terminal.on('input', ({ data }) => {
      subscription.dispose();
      resolve(new TextDecoder().decode(data));
    });
  });
}

async function bufferText(terminal: BrowserTerminal): Promise<string> {
  return (await terminal.readBuffer()).rows.map((row) => row.text).join('\n');
}

async function retainedBufferText(terminal: BrowserTerminal): Promise<string> {
  const empty = await terminal.readBuffer({ start: 0, end: 0 });
  const retained = await terminal.readBuffer({ start: 0, end: empty.state.totalRows });
  return retained.rows.map((row) => row.text).join('\n');
}

async function waitForTerminalText(
  terminal: BrowserTerminal,
  expected: string,
  timeout = 8_000
): Promise<string> {
  let latest = '';
  await waitFor(
    async () => {
      latest = await bufferText(terminal);
      return latest.includes(expected);
    },
    timeout,
    `terminal text ${JSON.stringify(expected)}`
  );
  return latest;
}

async function submitShellCommand(
  terminal: BrowserTerminal,
  command: string,
  expected: string
): Promise<string> {
  const before = await bufferText(terminal);
  const promptCount = countOccurrences(before, 'harness $ ');
  terminal.sendText(`${command}\r`);
  await waitForPromptCount(terminal, 'harness $ ', promptCount + 1);
  const output = await bufferText(terminal);
  assert(output.includes(expected), `${command} did not produce ${JSON.stringify(expected)}`);
  return output;
}

async function waitForPromptCount(
  terminal: BrowserTerminal,
  prompt: string,
  expected: number
): Promise<void> {
  await waitFor(
    async () => countOccurrences(await bufferText(terminal), prompt) >= expected,
    10_000,
    `prompt ${expected}`
  );
}

async function readThroughPrompt(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prompt: string
): Promise<string> {
  const decoder = new TextDecoder();
  let output = '';
  while (!output.endsWith(prompt)) {
    const next = await reader.read();
    if (next.done) throw new Error('BashKit closed before its next prompt');
    output += decoder.decode(next.value, { stream: true });
  }
  return output;
}

function submitMobileInput(textarea: HTMLTextAreaElement, command: string): void {
  textarea.value = `${command}\n`;
  textarea.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: null })
  );
}

function dispatchPaste(element: HTMLElement, text: string): void {
  const transfer = new DataTransfer();
  transfer.setData('text/plain', text);
  let event: ClipboardEvent;
  try {
    event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
  } catch {
    event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
  }
  if (event.clipboardData?.getData('text/plain') !== text) {
    Object.defineProperty(event, 'clipboardData', { value: transfer });
  }
  element.dispatchEvent(event);
}

function websocketUrl(path: string, token: string): string {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.href;
}

function writeXterm(
  terminal: GespenstXterm | UpstreamXterm,
  data: string | Uint8Array
): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function xtermBufferText(terminal: GespenstXterm): string {
  return Array.from({ length: terminal.buffer.active.length }, (_, index) =>
    terminal.buffer.active.getLine(index)?.translateToString(true)
  ).join('\n');
}

function waitForSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Attach socket failed')), {
      once: true,
    });
  });
}

function frameworkCell(parent: HTMLElement, label: string): HTMLElement {
  const cell = document.createElement('div');
  cell.style.cssText = 'min-width:0;height:100%;position:relative;overflow:hidden';
  cell.setAttribute('aria-label', label);
  parent.append(cell);
  return cell;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout: number,
  label: string
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function withTimeout<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} exceeded ${timeout} ms`)),
      timeout
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

function formatDetails(details: Record<string, unknown>, durationMs: number): string {
  return `${durationMs} ms\n${Object.entries(details)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join('\n')}`;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

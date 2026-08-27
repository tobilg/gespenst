import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import pty from '@lydell/node-pty';
import { chromium, devices, firefox, webkit } from 'playwright';
import { build as viteBuild } from 'vite';
import WebSocket, { WebSocketServer } from 'ws';
import {
  assertScenarioCoverage,
  EXTERNAL_CONSUMER_DEPENDENCIES,
  PUBLISHED_SCENARIOS,
  parsePublishedHarnessArgs,
  resolveRegistryPackage,
  verifyRegistryInstallation,
} from './published-harness-utils.mjs';
import { discoverPublicPackages } from './release-utils.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parsePublishedHarnessArgs(process.argv.slice(2));
const timestamp = new Date()
  .toISOString()
  .replaceAll(':', '-')
  .replace(/\.\d{3}Z$/u, 'Z');
const reportRoot = resolve(root, 'test-results', 'published', timestamp);
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'gespenst-published-harness-'));
const consumerRoot = resolve(temporaryRoot, 'consumer');
const templateRoot = resolve(root, 'harness', 'published');
const websocketToken = randomBytes(32).toString('base64url');
let server;
let interrupted = false;

process.once('SIGINT', () => {
  interrupted = true;
  if (options.command === 'dev') cleanDevExit();
  else void shutdown().then(() => process.exit(130));
});
process.once('SIGTERM', () => {
  interrupted = true;
  if (options.command === 'dev') cleanDevExit();
  else void shutdown().then(() => process.exit(143));
});

function cleanDevExit() {
  if (!options.keep) rmSync(temporaryRoot, { recursive: true, force: true });
  process.exit(0);
}

try {
  await mkdir(reportRoot, { recursive: true });
  console.log(`Resolving published packages from npm using selector ${options.selector}…`);
  const workspacePackages = await discoverPublicPackages(root);
  const packageNames = workspacePackages.map(({ manifest }) => manifest.name).sort();
  assertScenarioCoverage(packageNames);
  const [packages, upstreamXterm] = await Promise.all([
    Promise.all(packageNames.map((name) => resolveRegistryPackage(name, options.selector))),
    resolveRegistryPackage('@xterm/xterm', 'latest'),
  ]);
  console.log(
    `Resolved ${packages.length} Gespenst packages (${versionSummary(packages)}) and ` +
      `@xterm/xterm@${upstreamXterm.version}`
  );

  await cp(templateRoot, consumerRoot, { recursive: true });
  const manifest = consumerManifest(packages, upstreamXterm);
  await writeFile(resolve(consumerRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(resolve(consumerRoot, 'public'), { recursive: true });
  const baseMetadata = {
    selector: options.selector,
    generatedAt: new Date().toISOString(),
    websocketToken,
    consumerDependencies: manifest.dependencies,
    packages: packages.map((item) => ({
      ...item,
      scenario: PUBLISHED_SCENARIOS[item.name],
    })),
    upstreamXterm: { ...upstreamXterm, scenario: 'performance-baseline' },
  };
  await writeFile(
    resolve(consumerRoot, 'public', 'metadata.json'),
    `${JSON.stringify(baseMetadata, null, 2)}\n`
  );

  console.log(`Installing into isolated consumer ${consumerRoot}`);
  await run(
    'pnpm',
    ['install', '--ignore-scripts', '--config.auto-install-peers=false'],
    consumerRoot
  );
  const installed = await verifyRegistryInstallation(consumerRoot, packages);
  console.log(`Verified ${installed.length} registry installations with no local links`);

  await run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumerRoot);
  await run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.nodenext.json'], consumerRoot);
  const headless = JSON.parse((await run('node', ['headless.mjs'], consumerRoot)).trim());
  console.log(`Passed published headless runtime (${headless.snapshotBytes} snapshot bytes)`);

  const bundles = await buildBundles();
  const distRoot = resolve(consumerRoot, 'dist');
  await viteBuild({
    root: consumerRoot,
    configFile: false,
    logLevel: 'warn',
    define: {
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    build: {
      target: 'es2022',
      outDir: distRoot,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(consumerRoot, 'index.html'),
          benchmark: resolve(consumerRoot, 'benchmark.html'),
        },
      },
    },
  });
  const appAssets = await analyzeAssets(distRoot);
  const metadata = { ...baseMetadata, bundles: { ...bundles, harness: appAssets } };
  await writeFile(resolve(distRoot, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await validateBuiltAssets(distRoot);
  console.log('Built the published-package consumer and emitted its WASM and CSS assets');

  server = await createHarnessServer({
    distRoot,
    host: options.host,
    token: websocketToken,
    ptyCwd: temporaryRoot,
  });
  console.log(`Published package harness: ${server.localUrl}`);
  for (const url of server.networkUrls) console.log(`Device URL: ${url}`);
  if (options.host === '0.0.0.0') {
    console.warn(
      'The harness and a real shell PTY are exposed to the local network until stopped.'
    );
  }

  if (options.command === 'dev') {
    console.log('Press Ctrl+C to stop the harness.');
    await new Promise(() => {});
  } else {
    const browserReports = [];
    for (const browserName of options.browsers) {
      const withBenchmarks = browserName === 'chromium';
      browserReports.push(
        await runBrowser(browserName, server.localUrl, reportRoot, withBenchmarks)
      );
    }
    const finalReport = {
      generatedAt: new Date().toISOString(),
      selector: options.selector,
      packages: metadata.packages,
      upstreamXterm: metadata.upstreamXterm,
      headless,
      bundles: metadata.bundles,
      browsers: browserReports,
    };
    await writeFile(
      resolve(reportRoot, 'report.json'),
      `${JSON.stringify(finalReport, null, 2)}\n`
    );
    await writeFile(resolve(reportRoot, 'summary.md'), markdownSummary(finalReport));
    console.log(`Published package validation passed in ${browserReports.length} browser profiles`);
    console.log(`Report: ${resolve(reportRoot, 'summary.md')}`);
  }
} catch (error) {
  if (!interrupted) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    console.error(`Diagnostics: ${reportRoot}`);
    process.exitCode = 1;
  }
} finally {
  if (options.command !== 'dev' || process.exitCode) await shutdown();
}

async function shutdown() {
  await server?.close();
  server = undefined;
  if (options.keep) console.log(`Kept isolated consumer: ${temporaryRoot}`);
  else await rm(temporaryRoot, { recursive: true, force: true });
}

function consumerManifest(packages, upstreamXterm) {
  return {
    name: 'gespenst-published-package-harness',
    private: true,
    type: 'module',
    engines: { node: '^20.19.0 || >=22.12.0' },
    dependencies: {
      ...Object.fromEntries(packages.map(({ name, version }) => [name, version])),
      ...EXTERNAL_CONSUMER_DEPENDENCIES,
      '@xterm/xterm': upstreamXterm.version,
      typescript: '7.0.2',
      vite: '8.2.2',
    },
  };
}

async function buildBundles() {
  const entries = {
    native: resolve(consumerRoot, 'bundle', 'native.ts'),
    compatibility: resolve(consumerRoot, 'bundle', 'compat.ts'),
    upstream: resolve(consumerRoot, 'bundle', 'upstream.ts'),
  };
  const reports = {};
  for (const [name, entry] of Object.entries(entries)) {
    const output = resolve(consumerRoot, `dist-bundle-${name}`);
    await viteBuild({
      root: consumerRoot,
      configFile: false,
      logLevel: 'silent',
      publicDir: false,
      build: {
        target: 'es2022',
        outDir: output,
        emptyOutDir: true,
        assetsInlineLimit: 0,
        sourcemap: false,
        rollupOptions: { input: entry },
      },
    });
    reports[name] = await analyzeAssets(output);
  }
  return reports;
}

async function analyzeAssets(directory) {
  const assets = [];
  for (const file of await filesRecursively(directory)) {
    if (file.endsWith('.map')) continue;
    const bytes = await readFile(file);
    assets.push({
      file: relative(directory, file),
      bytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes).byteLength,
      brotliBytes: brotliCompressSync(bytes).byteLength,
    });
  }
  assets.sort((left, right) => left.file.localeCompare(right.file));
  return {
    assets,
    totals: {
      bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
      gzipBytes: assets.reduce((total, asset) => total + asset.gzipBytes, 0),
      brotliBytes: assets.reduce((total, asset) => total + asset.brotliBytes, 0),
    },
  };
}

async function validateBuiltAssets(directory) {
  const files = await filesRecursively(directory);
  const wasm = await Promise.all(
    files.filter((file) => file.endsWith('.wasm')).map(async (file) => (await stat(file)).size)
  );
  if (!wasm.some((size) => size > 900_000) || !wasm.some((size) => size < 1_000)) {
    throw new Error('Published consumer did not emit both default core WASM assets');
  }
  if (!files.some((file) => file.endsWith('.css'))) {
    throw new Error('Published consumer did not emit terminal CSS');
  }
}

async function runBrowser(name, baseUrl, output, benchmark) {
  const kind = name.includes('chromium') ? chromium : name.includes('firefox') ? firefox : webkit;
  const browser = await kind.launch({ headless: true });
  const mobile = name.startsWith('mobile-');
  const context = await browser.newContext(
    mobile
      ? name === 'mobile-webkit'
        ? devices['iPhone 15 Pro']
        : devices['Pixel 7']
      : { viewport: { width: 1440, height: 1000 } }
  );
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const errors = [];
  const badResponses = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('response', (response) => {
    const type = response.headers()['content-type'] ?? '';
    if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    if (response.url().endsWith('.wasm') && !type.startsWith('application/wasm')) {
      badResponses.push(`bad WASM MIME ${type || '(missing)'} ${response.url()}`);
    }
  });
  const trace = resolve(output, `${name}-trace.zip`);
  try {
    console.log(
      `Running published package scenarios in ${name}${benchmark ? ' with benchmarks' : ''}…`
    );
    await page.goto(`${baseUrl}/?automated=1${benchmark ? '&benchmark=1' : ''}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    const report = await page.evaluate(async () => window.__gespenstPublishedHarness);
    await writeFile(resolve(output, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
    const failures = report.functional.scenarios.filter((scenario) => scenario.status !== 'passed');
    if (failures.length) {
      throw new Error(
        `${name} scenarios failed:\n${failures.map((failure) => `- ${failure.label}: ${failure.error}`).join('\n')}`
      );
    }
    if (errors.length) throw new Error(`${name} browser errors:\n${errors.join('\n')}`);
    if (badResponses.length)
      throw new Error(`${name} resource failures:\n${badResponses.join('\n')}`);
    await context.tracing.stop();
    await browser.close();
    return { name, benchmark, report };
  } catch (error) {
    await page.screenshot({ path: resolve(output, `${name}-failure.png`), fullPage: true });
    await context.tracing.stop({ path: trace });
    await browser.close();
    throw error;
  }
}

async function run(command, arguments_, cwd) {
  try {
    const { stdout, stderr } = await execute(command, arguments_, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });
    if (stderr.trim()) console.error(stderr.trim());
    return stdout;
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    throw new Error(
      `${command} ${arguments_.join(' ')} failed${stdout ? `\n${stdout}` : ''}${stderr ? `\n${stderr}` : ''}`,
      { cause: error }
    );
  }
}

async function filesRecursively(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await filesRecursively(path)));
    else output.push(path);
  }
  return output;
}

function versionSummary(packages) {
  const versions = [...new Set(packages.map(({ version }) => version))];
  return versions.length === 1 ? versions[0] : versions.join(', ');
}

function markdownSummary(report) {
  const lines = [
    '# Published package harness',
    '',
    `- Selector: \`${report.selector}\``,
    `- Gespenst packages: ${report.packages.length}`,
    `- Upstream xterm.js: \`${report.upstreamXterm.version}\``,
    `- Browser profiles: ${report.browsers.map(({ name }) => name).join(', ')}`,
    '',
    '## Functional results',
    '',
    '| Browser | Scenarios | Renderer |',
    '| --- | ---: | --- |',
    ...report.browsers.map(
      ({ name, report: browser }) =>
        `| ${name} | ${browser.functional.scenarios.length} passed | ${browser.functional.renderer ?? 'n/a'} |`
    ),
    '',
    '## Bundle totals',
    '',
    '| Consumer | Raw bytes | Gzip bytes | Brotli bytes |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(report.bundles).map(
      ([name, value]) =>
        `| ${name} | ${value.totals.bytes} | ${value.totals.gzipBytes} | ${value.totals.brotliBytes} |`
    ),
    '',
  ];
  const benchmark = report.browsers.find(({ benchmark }) => benchmark)?.report.benchmarks;
  if (benchmark) {
    lines.push(
      '## Comparative performance',
      '',
      '| Implementation | Mode | Workload | Median | p95 |',
      '| --- | --- | --- | ---: | ---: |',
      ...benchmark.cases.map(
        (item) =>
          `| ${item.implementation} | ${item.mode} | ${item.workload} | ${item.summary.median} ${item.unit} | ${item.summary.p95} ${item.unit} |`
      ),
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

async function createHarnessServer({ distRoot, host, token, ptyCwd }) {
  const sessions = new Set();
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
  });
  const http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const requested =
        url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = resolve(distRoot, requested);
      if (file !== distRoot && !file.startsWith(`${distRoot}${sep}`))
        throw new Error('Invalid path');
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': contentType(file),
        'Cache-Control': file.endsWith('metadata.json') ? 'no-store' : 'public, max-age=60',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
  http.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (
      !['/ws/mock', '/ws/pty', '/ws/attach'].includes(url.pathname) ||
      url.searchParams.get('token') !== token
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (!origin || new URL(origin).host !== request.headers.host) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit('connection', webSocket, request, url);
    });
  });
  sockets.on('connection', (socket, _request, url) => {
    if (url.pathname === '/ws/mock') configureMockSocket(socket);
    else if (url.pathname === '/ws/attach') configureAttachSocket(socket);
    else configurePtySocket(socket, sessions, ptyCwd);
  });
  await new Promise((accept, reject) => {
    http.once('error', reject);
    http.listen(0, host, () => {
      http.off('error', reject);
      accept();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new Error('Harness server did not expose a TCP address');
  const localUrl = `http://127.0.0.1:${address.port}`;
  const networkUrls = host === '0.0.0.0' ? localNetworkUrls(address.port) : [];
  return {
    localUrl,
    networkUrls,
    async close() {
      for (const session of [...sessions]) closePtySession(session, sessions);
      for (const socket of sockets.clients) socket.close(1001, 'Harness stopped');
      await new Promise((accept) => sockets.close(() => accept()));
      await new Promise((accept) => http.close(() => accept()));
    },
  };
}

function configureMockSocket(socket) {
  const decoder = new TextDecoder();
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      const value = decoder.decode(data);
      if (value.includes('exit-mock')) {
        socket.send(JSON.stringify({ type: 'exit', code: 0 }));
      } else if (value.includes('ping')) socket.send(Buffer.from('mock:ping\r\n'));
      return;
    }
    try {
      const control = JSON.parse(data.toString());
      if (control.type === 'hello') socket.send(Buffer.from('mock-ready\r\n'));
      if (control.type === 'resize') {
        socket.send(Buffer.from(`mock-resize ${control.cols}x${control.rows}\r\n`));
      }
    } catch {
      socket.close(1003, 'Invalid control frame');
    }
  });
}

function configureAttachSocket(socket) {
  socket.send('attach-ready');
  socket.on('message', (data) => socket.send(`attach:${data.toString()}`));
}

function configurePtySocket(socket, sessions, cwd) {
  const terminal = pty.spawn(shellPath(), shellArguments(), {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PS1: 'pty $ ',
    },
  });
  const session = { socket, terminal, closed: false };
  sessions.add(session);
  terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(Buffer.from(data));
  });
  terminal.onExit(({ exitCode }) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'exit', code: exitCode }));
    closePtySession(session, sessions, false);
  });
  socket.on('message', (data, isBinary) => {
    if (isBinary) terminal.write(data.toString());
    else {
      try {
        const control = JSON.parse(data.toString());
        if (
          (control.type === 'hello' || control.type === 'resize') &&
          validDimension(control.cols) &&
          validDimension(control.rows)
        ) {
          terminal.resize(control.cols, control.rows);
        }
      } catch {
        socket.close(1003, 'Invalid control frame');
      }
    }
  });
  socket.on('close', () => closePtySession(session, sessions));
  socket.on('error', () => closePtySession(session, sessions));
}

function closePtySession(session, sessions, kill = true) {
  if (session.closed) return;
  session.closed = true;
  sessions.delete(session);
  if (kill) {
    try {
      session.terminal.kill();
    } catch {
      // The PTY may already have exited.
    }
  }
  if (session.socket.readyState === WebSocket.OPEN) session.socket.close(1001, 'PTY closed');
}

function shellPath() {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

function shellArguments() {
  return process.platform === 'win32' ? [] : ['-i'];
}

function validDimension(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function localNetworkUrls(port) {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal)
        urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

function contentType(file) {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
  };
  return types[extname(file)] ?? 'application/octet-stream';
}

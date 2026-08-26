import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { build as viteBuild } from 'vite';
import { discoverPublicPackages, packPublicPackages } from './release-utils.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = resolve(root, 'packages');
const workingRoot = await mkdtemp(resolve(tmpdir(), 'gespenst-pack-'));
const archiveArgument = valueAfter(process.argv.slice(2), '--archives');
const archiveRoot = archiveArgument
  ? resolve(root, archiveArgument)
  : resolve(workingRoot, 'archives');

function exportedFiles(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(exportedFiles);
}

const noticeMarkers = new Map([
  [
    '@gespenst/core',
    [
      'Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors',
      'Permission is hereby granted, free of charge',
      'THE SOFTWARE IS PROVIDED "AS IS"',
    ],
  ],
  [
    '@gespenst/xterm',
    [
      'Copyright (c) 2017-2019, The xterm.js authors',
      'Copyright (c) 2014-2016, SourceLair Private Company',
      'Copyright (c) 2012-2013, Christopher Jeffrey',
      'Permission is hereby granted, free of charge',
    ],
  ],
  [
    '@gespenst/themes',
    [
      'Copyright (c) 2023 Dracula Theme',
      'Copyright (c) 2021 Catppuccin',
      'Copyright (c) 2018-present Enkia',
      'Copyright (c) 2016-present Sven Greb',
      'Pavel Pertsev <morhetz@gmail.com>',
      'Copyright (c) 2011 Ethan Schoonover',
    ],
  ],
]);

try {
  const packageDirectories = await discoverPublicPackages(root);
  const projectLicense = await readFile(resolve(root, 'LICENSE'), 'utf8');
  const plan = archiveArgument
    ? JSON.parse(await readFile(resolve(archiveRoot, 'publish-plan.json'), 'utf8'))
    : (await packPublicPackages(root, archiveRoot)).plan;
  const archiveByName = new Map(plan.map((item) => [item.name, item.archive]));
  if (archiveByName.size !== packageDirectories.length) {
    throw new Error('Release archive plan does not match the public package set');
  }

  for (const { manifest } of packageDirectories) {
    const planned = plan.find((item) => item.name === manifest.name);
    const archive = planned?.archive;
    if (!archive) throw new Error(`No release archive was produced for ${manifest.name}`);
    const archivePath = resolve(archiveRoot, archive);
    const archiveBytes = await readFile(archivePath);
    const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
    const integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
    if (sha256 !== planned.sha256 || integrity !== planned.integrity) {
      throw new Error(`Release archive checksum mismatch for ${manifest.name}`);
    }
    const { stdout } = await execute('tar', ['-tf', archivePath], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const files = new Set(stdout.trim().split('\n'));
    const required = new Set([
      'package/package.json',
      'package/README.md',
      'package/LICENSE',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      ...exportedFiles(manifest.exports).map((file) => `package/${file.replace(/^\.\//u, '')}`),
    ]);
    if (manifest.name === '@gespenst/core') {
      for (const file of [
        'package/dist/core.js',
        'package/dist/core/index.d.ts',
        'package/dist/index.css',
        'package/dist/ghostty-vt.wasm',
        'package/dist/ghostty-callbacks.wasm',
        'package/THIRD_PARTY_NOTICES.md',
      ]) {
        required.add(file);
      }
    }
    if (manifest.name === '@gespenst/xterm') {
      required.add('package/dist/xterm.css');
      required.add('package/THIRD_PARTY_NOTICES.md');
    }
    if (manifest.name === '@gespenst/themes') {
      required.add('package/THIRD_PARTY_NOTICES.md');
    }
    for (const file of required) {
      if (!files.has(file)) throw new Error(`${manifest.name} is missing ${file.slice(8)}`);
    }
    const { stdout: packagedLicense } = await execute(
      'tar',
      ['-xOf', archivePath, 'package/LICENSE'],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    if (packagedLicense !== projectLicense) {
      throw new Error(`${manifest.name} LICENSE does not match the workspace license`);
    }
    const markers = noticeMarkers.get(manifest.name);
    if (markers) {
      const { stdout: notice } = await execute(
        'tar',
        ['-xOf', archivePath, 'package/THIRD_PARTY_NOTICES.md'],
        { maxBuffer: 10 * 1024 * 1024 }
      );
      for (const marker of markers) {
        if (!notice.includes(marker)) {
          throw new Error(`${manifest.name} third-party notice is missing ${marker}`);
        }
      }
    }
    console.log(`Validated ${manifest.name}: ${archive} (${files.size} files)`);
  }

  const svelte = packageDirectories.find(({ manifest }) => manifest.name === '@gespenst/svelte');
  if (svelte?.manifest.peerDependencies?.svelte !== '>=5.55.7 <6') {
    throw new Error('@gespenst/svelte must require the audited Svelte peer range >=5.55.7 <6');
  }

  const xtermCss = await readFile(resolve(packagesRoot, 'xterm/dist/xterm.css'), 'utf8');
  if (!xtermCss.includes('.xterm') || !xtermCss.includes('.gespenst__canvas')) {
    throw new Error('Published xterm stylesheet does not include required core styles');
  }

  const consumerRoot = resolve(workingRoot, 'consumer');
  await mkdir(consumerRoot, { recursive: true });
  const publicNames = new Set(packageDirectories.map(({ manifest }) => manifest.name));
  const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const externalPeers = new Set(
    packageDirectories.flatMap(({ manifest }) =>
      Object.keys(manifest.peerDependencies ?? {}).filter((name) => !publicNames.has(name))
    )
  );
  const consumerFixtures = new Set([...externalPeers, '@types/react']);
  const peerFixtures = Object.fromEntries(
    [...consumerFixtures].map((name) => {
      const version =
        rootManifest.devDependencies?.[name] ??
        packageDirectories.find(({ manifest }) => manifest.devDependencies?.[name])?.manifest
          .devDependencies[name];
      if (!version) throw new Error(`No packed-consumer fixture version is configured for ${name}`);
      return [name, version];
    })
  );
  const dependencies = {
    ...Object.fromEntries(
      plan.map(({ archive, name }) => [name, `file:${resolve(archiveRoot, archive)}`])
    ),
    ...peerFixtures,
  };
  await writeFile(
    resolve(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'gespenst-packed-consumer',
        private: true,
        type: 'module',
        dependencies,
        pnpm: {
          overrides: Object.fromEntries(
            plan.map(({ archive, name }) => [name, `file:${resolve(archiveRoot, archive)}`])
          ),
        },
      },
      null,
      2
    )}\n`
  );
  await execute(
    'pnpm',
    ['install', '--offline', '--ignore-scripts', '--config.auto-install-peers=false'],
    { cwd: consumerRoot, maxBuffer: 20 * 1024 * 1024 }
  );

  await verifyPackedHeadless(consumerRoot);
  await verifyNodeNextDeclarations(
    consumerRoot,
    packageDirectories.flatMap(({ manifest }) => declarationEntrySpecifiers(manifest))
  );
  await verifyPackedBrowser(consumerRoot);
  await verifyInstalledEntries(
    consumerRoot,
    packageDirectories.map(({ manifest }) => manifest.name)
  );

  const demoOutput = resolve(workingRoot, 'demo-dist');
  await viteBuild({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      outDir: demoOutput,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rollupOptions: { input: resolve(root, 'index.html') },
    },
  });
  await stat(resolve(demoOutput, 'index.html'));
  console.log('Root development demo bundled successfully');
} finally {
  await rm(workingRoot, { recursive: true, force: true });
}

async function verifyPackedHeadless(consumerRoot) {
  await execute(
    'node',
    [
      '--input-type=module',
      '--eval',
      "import { createCoreRuntime } from '@gespenst/core/headless';" +
        'const runtime = await createCoreRuntime();' +
        "const terminal = runtime.createTerminal({ cols: 20, rows: 2 });terminal.write('package smoke');" +
        "if (!terminal.viewport().viewportRows[0]?.text.includes('package smoke')) throw new Error('headless smoke failed');" +
        'runtime.dispose();',
    ],
    { cwd: consumerRoot, maxBuffer: 10 * 1024 * 1024 }
  );
  console.log('Packed core passed its headless runtime smoke test');
}

async function verifyNodeNextDeclarations(consumerRoot, specifiers) {
  await writeFile(
    resolve(consumerRoot, 'consumer.ts'),
    `${specifiers.map((specifier) => `import '${specifier}';`).join('\n')}\n`
  );
  await writeFile(
    resolve(consumerRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM'],
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: [],
      },
      include: ['consumer.ts'],
    })
  );
  await execute('pnpm', ['exec', 'tsc', '-p', resolve(consumerRoot, 'tsconfig.json')], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  console.log(`Packed declarations type-check under NodeNext (${specifiers.length} entries)`);
}

function declarationEntrySpecifiers(manifest) {
  return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
    if (!target || typeof target !== 'object' || typeof target.types !== 'string') return [];
    return [subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`];
  });
}

async function verifyPackedBrowser(consumerRoot) {
  await writeFile(
    resolve(consumerRoot, 'index.html'),
    '<!doctype html><html><body><div id="native"></div><div id="xterm"></div><script type="module" src="/index.js"></script></body></html>\n'
  );
  await writeFile(resolve(consumerRoot, 'index.js'), browserFixture());
  const output = resolve(consumerRoot, 'dist');
  await viteBuild({
    configFile: false,
    root: consumerRoot,
    logLevel: 'silent',
    build: {
      outDir: output,
      assetsInlineLimit: 0,
      rollupOptions: { input: resolve(consumerRoot, 'index.html') },
    },
  });
  const consumerFiles = await filesRecursively(output);
  const wasmSizes = await Promise.all(
    consumerFiles
      .filter((file) => file.endsWith('.wasm'))
      .map(async (file) => (await stat(file)).size)
  );
  if (!wasmSizes.some((size) => size > 900_000) || !wasmSizes.some((size) => size < 1_000)) {
    throw new Error('Packed consumer build did not emit both default WASM assets');
  }

  const server = await serve(output);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    const workers = [];
    const wasmResponses = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('worker', (worker) => workers.push(worker.url()));
    page.on('response', (response) => {
      if (response.url().endsWith('.wasm')) {
        wasmResponses.push({
          status: response.status(),
          type: response.headers()['content-type'],
          url: response.url(),
        });
      }
    });
    await page.goto(server.url);
    const result = await page.evaluate(() => globalThis.__gespenstPackedTest);
    if (!result.nativeText.includes('packed core \u754c\ud83d\ude42')) {
      throw new Error(`Packed core browser output was incorrect: ${result.nativeText}`);
    }
    if (!result.xtermText.includes('packed xterm \u754c\ud83d\ude42')) {
      throw new Error(`Packed xterm browser output was incorrect: ${result.xtermText}`);
    }
    if (result.input !== 'typed' || result.cols !== 40 || result.rows !== 8) {
      throw new Error(`Packed core input or resize failed: ${JSON.stringify(result)}`);
    }
    if (result.clipboardInput !== 'clipboard paste') {
      throw new Error(`Packed clipboard addon failed: ${JSON.stringify(result)}`);
    }
    if (result.canvasPosition !== 'absolute' || result.textareaOpacity !== '0') {
      throw new Error(`Packed terminal CSS was not applied: ${JSON.stringify(result)}`);
    }
    if (result.nativeChildren !== 0 || result.xtermChildren !== 0) {
      throw new Error('Packed terminal disposal left owned DOM behind');
    }
    if (workers.length === 0) throw new Error('Packed default terminal did not start a worker');
    if (wasmResponses.length < 2)
      throw new Error('Packed terminal did not request both WASM assets');
    for (const response of wasmResponses) {
      if (response.status !== 200 || !response.type?.startsWith('application/wasm')) {
        throw new Error(`Invalid WASM response: ${JSON.stringify(response)}`);
      }
    }
    if (errors.length > 0) throw new Error(`Packed browser errors:\n${errors.join('\n')}`);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log('Packed core and xterm passed their Chromium consumer smoke test');
}

async function verifyInstalledEntries(consumerRoot, names) {
  await execute(
    'node',
    [
      '--input-type=module',
      '--eval',
      `await Promise.all(${JSON.stringify(names)}.map(import.meta.resolve).map((url) => import(url)));`,
    ],
    { cwd: consumerRoot, maxBuffer: 10 * 1024 * 1024 }
  );
  console.log('Imported every installed package entry point successfully');
}

function browserFixture() {
  return `
import { createTerminal } from '@gespenst/core';
import '@gespenst/core/style.css';
import { ClipboardAddon } from '@gespenst/clipboard';
import { Terminal } from '@gespenst/xterm';
import '@gespenst/xterm/css/xterm.css';

globalThis.__gespenstPackedTest = (async () => {
  const nativeHost = document.querySelector('#native');
  const xtermHost = document.querySelector('#xterm');
  for (const host of [nativeHost, xtermHost]) {
    host.style.width = '480px';
    host.style.height = '240px';
  }
  const native = await createTerminal({
    container: nativeHost,
    cols: 32,
    rows: 6,
    renderer: 'canvas2d',
  });
  const input = new Promise((resolve) => native.on('input', ({ data }) => resolve(new TextDecoder().decode(data))));
  await native.writeAsync('\\x1b[32mpacked core\\x1b[0m \\u754c\\ud83d\\ude42');
  const nativeText = (await native.readViewport()).viewportRows[0]?.text ?? '';
  native.sendText('typed');
  const typed = await input;
  const clipboard = new ClipboardAddon();
  native.loadAddon(clipboard);
  await clipboard.ready;
  const clipboardInput = new Promise((resolve) => native.on('input', ({ data }) => resolve(new TextDecoder().decode(data))));
  const transfer = new DataTransfer();
  transfer.setData('text/plain', 'clipboard paste');
  native.element.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: transfer,
  }));
  native.resize(40, 8);
  const canvasPosition = getComputedStyle(native.element.querySelector('.gespenst__canvas')).position;
  const textareaOpacity = getComputedStyle(native.element.querySelector('textarea')).opacity;

  const xterm = new Terminal({ cols: 32, rows: 6 });
  xterm.open(xtermHost);
  await xterm.ready;
  await new Promise((resolve) => xterm.write('packed xterm \\u754c\\ud83d\\ude42', resolve));
  const xtermText = xterm.buffer.active.getLine(0)?.translateToString(true) ?? '';
  xterm.resize(40, 8);
  native.dispose();
  xterm.dispose();
  return {
    nativeText,
    xtermText,
    input: typed,
    clipboardInput: await clipboardInput,
    cols: 40,
    rows: 8,
    canvasPosition,
    textareaOpacity,
    nativeChildren: nativeHost.childElementCount,
    xtermChildren: xtermHost.childElementCount,
  };
})();
`;
}

async function serve(directory) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = resolve(directory, requested);
      if (!file.startsWith(`${directory}/`)) throw new Error('Invalid path');
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': contentType(file),
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start package server');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

function contentType(file) {
  if (extname(file) === '.wasm') return 'application/wasm';
  if (extname(file) === '.js') return 'text/javascript; charset=utf-8';
  if (extname(file) === '.css') return 'text/css; charset=utf-8';
  return 'text/html; charset=utf-8';
}

async function filesRecursively(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesRecursively(path)));
    else files.push(path);
  }
  return files;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

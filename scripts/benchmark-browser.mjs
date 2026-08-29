import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, freemem, hostname, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';
import { build as viteBuild } from 'vite';
import { benchmarkFrameTimeoutMs, retryCadence, withTimeout } from './benchmark-runner-utils.mjs';
import { resolveRegistryPackage } from './published-harness-utils.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = resolve(root, 'harness', 'published');
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const timestamp = new Date()
  .toISOString()
  .replaceAll(':', '-')
  .replace(/\.\d{3}Z$/u, 'Z');
const reportRoot = resolve(root, 'test-results', 'benchmarks', timestamp);
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'gespenst-browser-benchmark-'));
let server;
let browser;

try {
  await mkdir(reportRoot, { recursive: true });
  const workspacePackages =
    options.candidate.kind === 'workspace' || options.baseline.kind === 'workspace'
      ? await buildWorkspacePackages()
      : undefined;
  const upstream = await resolveRegistryPackage('@xterm/xterm', options.upstream);
  const candidate = await buildConsumer(
    'candidate',
    options.candidate,
    workspacePackages,
    upstream
  );
  const baseline = await buildConsumer('baseline', options.baseline, workspacePackages, upstream);
  server = await serveBuilds({ candidate: candidate.distRoot, baseline: baseline.distRoot });

  const startedAt = new Date().toISOString();
  const provenance = await collectProvenance(candidate, baseline, upstream);
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: startedAt,
    configuration: {
      candidate: options.candidate.raw,
      baseline: options.baseline.raw,
      upstream: options.upstream,
      profile: options.profile,
      browsers: options.browsers,
      seed: options.seed,
    },
    provenance,
    browsers: [],
  };
  for (const browserName of options.browsers) {
    console.log(`Benchmarking in ${browserName} (${options.profile} profile)…`);
    report.browsers.push(await runBrowserSuite(browserName, server.url));
    report.completedAt = new Date().toISOString();
    await writeBenchmarkReport(report);
    console.log(
      `Benchmark checkpoint (${report.browsers.length}/${options.browsers.length}): ${resolve(reportRoot, 'summary.md')}`
    );
  }
  const summary = markdownSummary(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`Benchmark report: ${resolve(reportRoot, 'summary.md')}`);
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
} finally {
  await closeActiveBrowser();
  await server?.close();
  if (options.keep) console.log(`Kept isolated benchmark consumers: ${temporaryRoot}`);
  else await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(arguments_) {
  const parsed = {
    candidate: parseSource('workspace'),
    baseline: parseSource('npm:latest'),
    upstream: '6.0.0',
    profile: 'full',
    browsers: ['chromium'],
    seed: 0x5e5e_5e5e,
    keep: false,
    help: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    if (argument === '--keep') {
      parsed.keep = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (
      ['--candidate', '--baseline', '--upstream', '--profile', '--browser', '--seed'].includes(
        argument
      )
    ) {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--candidate') parsed.candidate = parseSource(value);
      else if (argument === '--baseline') parsed.baseline = parseSource(value);
      else if (argument === '--upstream') parsed.upstream = value;
      else if (argument === '--profile') parsed.profile = value;
      else if (argument === '--browser') parsed.browsers = value.split(',');
      else parsed.seed = Number(value);
      continue;
    }
    throw new Error(`Unknown benchmark option: ${argument}`);
  }
  if (!['full', 'ci'].includes(parsed.profile)) throw new Error('Profile must be full or ci');
  if (!Number.isSafeInteger(parsed.seed)) throw new Error('Seed must be a safe integer');
  for (const name of parsed.browsers) {
    if (!['chromium', 'firefox', 'webkit'].includes(name))
      throw new Error(`Unsupported browser: ${name}`);
  }
  return parsed;
}

function parseSource(value) {
  if (value === 'workspace') return { kind: 'workspace', raw: value };
  if (value.startsWith('npm:') && value.slice(4).trim())
    return { kind: 'npm', selector: value.slice(4), raw: value };
  throw new Error(`Package source must be workspace or npm:<selector>; received ${value}`);
}

function printHelp() {
  console.log(`Usage: pnpm bench:browser -- [options]

Options:
  --candidate workspace|npm:<selector>  Candidate packages (default: workspace)
  --baseline workspace|npm:<selector>   Gespenst baseline (default: npm:latest)
  --upstream <selector>                  @xterm/xterm baseline (default: 6.0.0)
  --profile full|ci                      Sampling profile (default: full)
  --browser <list>                       chromium, firefox, and/or webkit
  --seed <integer>                       Reproducible execution order
  --keep                                 Preserve isolated consumers
  --help                                 Show this help`);
}

async function buildWorkspacePackages() {
  console.log('Building and packing workspace @gespenst/core and @gespenst/xterm…');
  await run('pnpm', ['run', 'build:callbacks'], root);
  await run('pnpm', ['--filter', '@gespenst/core', 'build'], root);
  await run('pnpm', ['--filter', '@gespenst/xterm', 'build'], root);
  const archiveRoot = resolve(temporaryRoot, 'workspace-packages');
  await mkdir(archiveRoot, { recursive: true });
  const packages = {};
  for (const packageDirectory of ['core', 'xterm']) {
    const packageRoot = resolve(root, 'packages', packageDirectory);
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    const before = new Set(await readdir(archiveRoot));
    await run(
      'pnpm',
      ['pack', '--pack-destination', archiveRoot, '--config.ignore-scripts=true'],
      packageRoot
    );
    const archive = (await readdir(archiveRoot)).find(
      (entry) => entry.endsWith('.tgz') && !before.has(entry)
    );
    if (!archive) throw new Error(`Packing ${manifest.name} did not produce an archive`);
    const archivePath = resolve(archiveRoot, archive);
    const bytes = await readFile(archivePath);
    packages[manifest.name] = {
      name: manifest.name,
      version: manifest.version,
      archive: archivePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
  }
  return packages;
}

async function buildConsumer(key, source, workspacePackages, upstream) {
  const consumerRoot = resolve(temporaryRoot, key);
  await mkdir(resolve(consumerRoot, 'src'), { recursive: true });
  await cp(resolve(templateRoot, 'benchmark.html'), resolve(consumerRoot, 'benchmark.html'));
  for (const file of ['benchmark-frame.ts', 'benchmark-profile.ts', 'statistics.ts', 'types.ts'])
    await cp(resolve(templateRoot, 'src', file), resolve(consumerRoot, 'src', file));

  let packages;
  let dependencies;
  if (source.kind === 'workspace') {
    if (!workspacePackages) throw new Error('Workspace package archives are unavailable');
    packages = [workspacePackages['@gespenst/core'], workspacePackages['@gespenst/xterm']];
    dependencies = Object.fromEntries(packages.map((item) => [item.name, `file:${item.archive}`]));
  } else {
    packages = await Promise.all(
      ['@gespenst/core', '@gespenst/xterm'].map((name) =>
        resolveRegistryPackage(name, source.selector)
      )
    );
    dependencies = Object.fromEntries(packages.map((item) => [item.name, item.version]));
  }
  const manifest = {
    name: `gespenst-benchmark-${key}`,
    private: true,
    type: 'module',
    dependencies: {
      ...dependencies,
      '@xterm/xterm': upstream.version,
      typescript: '7.0.2',
      vite: '8.2.2',
    },
    ...(source.kind === 'workspace'
      ? {
          pnpm: {
            overrides: {
              '@gespenst/core': `file:${workspacePackages['@gespenst/core'].archive}`,
            },
          },
        }
      : {}),
  };
  await writeFile(resolve(consumerRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Installing isolated ${key} consumer from ${source.raw}…`);
  await run(
    'pnpm',
    ['install', '--ignore-scripts', '--config.auto-install-peers=false'],
    consumerRoot
  );
  await run(
    'pnpm',
    [
      'exec',
      'tsc',
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      '--target',
      'ES2022',
      '--lib',
      'ES2022,DOM',
      '--types',
      'vite/client',
      'src/benchmark-frame.ts',
    ],
    consumerRoot
  );
  const distRoot = resolve(consumerRoot, 'dist');
  await viteBuild({
    root: consumerRoot,
    base: `/${key}/`,
    configFile: false,
    logLevel: 'warn',
    build: {
      target: 'es2022',
      outDir: distRoot,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      sourcemap: true,
      rollupOptions: { input: resolve(consumerRoot, 'benchmark.html') },
    },
  });
  await verifyAssets(distRoot);
  return { key, source, packages, distRoot };
}

async function verifyAssets(directory) {
  const files = await filesRecursively(directory);
  const wasmSizes = await Promise.all(
    files.filter((file) => file.endsWith('.wasm')).map(async (file) => (await stat(file)).size)
  );
  if (!wasmSizes.some((size) => size > 900_000) || !wasmSizes.some((size) => size < 1_000))
    throw new Error(`Benchmark bundle ${directory} did not emit both core WASM assets`);
  if (!files.some((file) => file.endsWith('.css')))
    throw new Error(`Benchmark bundle ${directory} did not emit terminal CSS`);
}

async function serveBuilds(builds) {
  const http = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const [, key, ...segments] = decodeURIComponent(url.pathname).split('/');
      const directory = builds[key];
      if (!directory) throw new Error('Unknown build');
      const requested = segments.join('/') || 'benchmark.html';
      const file = resolve(directory, requested);
      if (file !== directory && !file.startsWith(`${directory}${sep}`)) throw new Error('Bad path');
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': contentType(file),
        'Cache-Control': 'no-store',
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
  await new Promise((resolvePromise, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Benchmark server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolvePromise, reject) =>
        http.close((error) => (error ? reject(error) : resolvePromise()))
      ),
  };
}

async function runBrowserSuite(browserName, baseUrl) {
  const browserKind =
    browserName === 'chromium' ? chromium : browserName === 'firefox' ? firefox : webkit;
  browser = await browserKind.launch({ headless: true });
  const version = browser.version();
  const definitions = [
    { runId: 'candidate-native', source: 'candidate', id: 'native-default' },
    { runId: 'candidate-canvas', source: 'candidate', id: 'native-canvas' },
    { runId: 'candidate-xterm', source: 'candidate', id: 'gespenst-xterm' },
    { runId: 'candidate-xterm-listeners', source: 'candidate', id: 'gespenst-xterm-listeners' },
    { runId: 'baseline-native', source: 'baseline', id: 'native-default' },
    { runId: 'baseline-xterm', source: 'baseline', id: 'gespenst-xterm' },
    { runId: 'upstream-xterm', source: 'baseline', id: 'upstream-xterm' },
    { runId: 'upstream-xterm-listeners', source: 'baseline', id: 'upstream-xterm-listeners' },
  ];
  const order = shuffled(definitions, options.seed);
  const frames = [];
  const environmentDiagnostics = [];
  for (const definition of order) {
    console.log(`  ${definition.runId}`);
    frames.push(
      await retryCadence(() => runFrame(baseUrl, definition, 'main'), {
        attempts: 3,
        delayMs: 1_000,
        onRetry: ({ attempt, attempts }) => {
          const diagnostic = `${definition.runId}: discarded unstable animation-frame cadence (attempt ${attempt}/${attempts})`;
          environmentDiagnostics.push(diagnostic);
          console.warn(`    ${diagnostic}; retrying`);
        },
      })
    );
  }

  const coldDefinitions = definitions.filter(({ runId }) => !runId.endsWith('-listeners'));
  const coldCount = options.profile === 'ci' ? 3 : 10;
  const coldRuns = shuffled(
    coldDefinitions.flatMap((definition) => Array.from({ length: coldCount }, () => definition)),
    options.seed ^ 0x9e37_79b9
  );
  const coldSamples = new Map();
  for (const definition of coldRuns) {
    const { result } = await runFrame(baseUrl, definition, 'cold');
    const sample = result.cases[0]?.summary.samples[0];
    if (sample === undefined) throw new Error(`${definition.runId} cold run returned no sample`);
    const values = coldSamples.get(definition.runId) ?? [];
    values.push(sample);
    coldSamples.set(definition.runId, values);
  }

  const cases = frames.flatMap(({ definition, result }) =>
    result.cases.map((item) => decorateCase(item, definition))
  );
  for (const definition of coldDefinitions) {
    const values = coldSamples.get(definition.runId) ?? [];
    cases.push({
      runId: definition.runId,
      source: definition.source,
      implementation: `${definition.runId}: cold start`,
      mode: 'fresh browser context per sample',
      workload: 'cold initialization and first presented write',
      boundary: 'initialization',
      direction: 'latency',
      unit: 'ms',
      summary: summarize(values, 'latency'),
    });
  }
  const warnings = frames.flatMap(({ definition, result }) =>
    result.validity.warnings.map((warning) => `${definition.runId}: ${warning}`)
  );
  const diagnostics = cases.flatMap((item) =>
    item.summary.warnings.map((warning) => `${item.runId} / ${item.workload}: ${warning}`)
  );
  const output = {
    name: browserName,
    version,
    order: order.map(({ runId }) => runId),
    validity: { valid: warnings.length === 0, warnings },
    environmentDiagnostics,
    diagnostics,
    frameCadence: Object.fromEntries(
      frames.map(({ definition, result }) => [definition.runId, result.frameCadence])
    ),
    health: Object.fromEntries(
      frames.map(({ definition, result }) => [definition.runId, result.health])
    ),
    cases,
    comparisons: comparisons(cases),
  };
  await closeActiveBrowser();
  return output;
}

async function runFrame(baseUrl, definition, suite) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const description = `${definition.runId} ${suite} frame`;
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  try {
    const query = new URLSearchParams({
      implementation: definition.id,
      profile: options.profile,
      suite,
    });
    const result = await withTimeout(
      (async () => {
        await page.goto(`${baseUrl}/${definition.source}/benchmark.html?${query}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        return page.evaluate(() => window.__gespenstBenchmarkFrame);
      })(),
      benchmarkFrameTimeoutMs(options.profile, suite),
      description
    );
    if (errors.length) throw new Error(errors.join('\n'));
    return { definition, result };
  } finally {
    try {
      await withTimeout(context.close(), 10_000, `${description} context shutdown`);
    } catch (error) {
      console.warn(error instanceof Error ? error.message : String(error));
    }
  }
}

function decorateCase(item, definition) {
  return {
    ...item,
    runId: definition.runId,
    source: definition.source,
    implementation: `${definition.runId}: ${item.implementation}`,
  };
}

function comparisons(cases) {
  const pairs = [
    ['candidate-native', 'baseline-native'],
    ['candidate-xterm', 'baseline-xterm'],
    ['candidate-xterm', 'upstream-xterm'],
    ['candidate-xterm-listeners', 'upstream-xterm-listeners'],
  ];
  const results = [];
  for (const [candidateId, referenceId] of pairs) {
    const candidateCases = cases.filter(({ runId }) => runId === candidateId);
    for (const candidate of candidateCases) {
      const reference = cases.find(
        (item) =>
          item.runId === referenceId &&
          item.workload === candidate.workload &&
          item.boundary === candidate.boundary &&
          item.unit === candidate.unit
      );
      if (!reference) continue;
      const count = Math.min(candidate.summary.samples.length, reference.summary.samples.length);
      const ratios = Array.from({ length: count }, (_, index) => {
        const candidateValue = candidate.summary.samples[index] ?? 0;
        const referenceValue = reference.summary.samples[index] ?? 0;
        if (candidateValue <= 0 || referenceValue <= 0) return 0;
        return candidate.direction === 'throughput'
          ? candidateValue / referenceValue
          : referenceValue / candidateValue;
      });
      results.push({
        candidate: candidateId,
        reference: referenceId,
        workload: candidate.workload,
        boundary: candidate.boundary,
        interpretation: 'greater than 1 means the candidate is faster',
        ratio: summarize(ratios, 'throughput'),
      });
    }
  }
  return results;
}

async function collectProvenance(candidate, baseline, upstream) {
  const [gitSha, gitStatus] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], root),
    run('git', ['status', '--short'], root),
  ]);
  return {
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      freeMemoryBytesAtStart: freemem(),
    },
    runtime: { node: process.version, playwright: '1.62.1' },
    git: { sha: gitSha.trim(), dirty: gitStatus.trim().length > 0 },
    sources: {
      candidate: sourceProvenance(candidate),
      baseline: sourceProvenance(baseline),
      upstreamXterm: upstream,
    },
  };
}

function sourceProvenance(consumer) {
  return {
    requested: consumer.source.raw,
    kind: consumer.source.kind,
    packages: consumer.packages.map(({ archive: _archive, ...item }) => item),
  };
}

function summarize(values, direction, seed = options.seed) {
  const mean = values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(1, values.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const p05 = percentile(values, 0.05);
  const p50 = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  const coefficientOfVariation = mean === 0 ? 0 : standardDeviation / Math.abs(mean);
  const confidence = bootstrapMedian(values, seed);
  const quantized =
    values.length >= 5 &&
    new Set(values.map((value) => Math.round(value * 1_000_000))).size <= 2 &&
    values.every((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-7);
  const warnings = [
    ...(coefficientOfVariation > 0.15
      ? [`high variance (${(coefficientOfVariation * 100).toFixed(1)}% CV)`]
      : []),
    ...(quantized ? ['samples are timing-quantized'] : []),
  ];
  return {
    median: round(p50),
    p05: round(p05),
    p95: round(p95),
    minimum: round(values.length ? Math.min(...values) : 0),
    maximum: round(values.length ? Math.max(...values) : 0),
    mean: round(mean),
    standardDeviation: round(standardDeviation),
    coefficientOfVariation: round(coefficientOfVariation),
    confidence95: { low: round(confidence.low), high: round(confidence.high) },
    tail: round(direction === 'latency' ? p95 : p05),
    valid: warnings.length === 0,
    warnings,
    samples: values.map(round),
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function bootstrapMedian(values, seed) {
  if (values.length === 0) return { low: 0, high: 0 };
  const random = mulberry32(seed);
  const medians = [];
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)] ?? 0
    );
    medians.push(percentile(sample, 0.5));
  }
  return { low: percentile(medians, 0.025), high: percentile(medians, 0.975) };
}

function shuffled(values, seed) {
  const output = [...values];
  const random = mulberry32(seed);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b_79f5;
    let output = value;
    output = Math.imul(output ^ (output >>> 15), output | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function markdownSummary(report) {
  const lines = [
    '# Gespenst browser benchmark',
    '',
    `- Candidate: \`${report.configuration.candidate}\``,
    `- Gespenst baseline: \`${report.configuration.baseline}\``,
    `- Upstream xterm.js: \`${report.configuration.upstream}\``,
    `- Profile: \`${report.configuration.profile}\``,
    `- Browsers completed: \`${report.browsers.length}/${report.configuration.browsers.length}\``,
    `- Seed: \`${report.configuration.seed}\``,
    `- Git: \`${report.provenance.git.sha}\`${report.provenance.git.dirty ? ' (dirty)' : ''}`,
    '',
  ];
  for (const browserReport of report.browsers) {
    lines.push(
      `## ${browserReport.name} ${browserReport.version}`,
      '',
      `Run validity: ${browserReport.validity.valid ? 'valid' : `review required — ${browserReport.validity.warnings.join('; ')}`}`,
      `Environment diagnostics: ${browserReport.environmentDiagnostics.length} cadence ${browserReport.environmentDiagnostics.length === 1 ? 'retry' : 'retries'}.`,
      `Sample diagnostics: ${browserReport.diagnostics.length} warning(s); inspect per-case CV and raw samples before drawing conclusions.`,
      '',
      '| Implementation | Boundary | Workload | Median | p05–p95 | CV |',
      '| --- | --- | --- | ---: | ---: | ---: |',
      ...browserReport.cases.map(
        (item) =>
          `| ${item.runId} | ${item.boundary} | ${item.workload} | ${item.summary.median} ${item.unit} | ${item.summary.p05}–${item.summary.p95} | ${(item.summary.coefficientOfVariation * 100).toFixed(1)}% |`
      ),
      '',
      '### Normalized comparisons',
      '',
      'Values above 1 mean the candidate is faster. These ratios are diagnostics, not release gates.',
      '',
      '| Candidate | Reference | Workload | Median ratio | 95% median CI |',
      '| --- | --- | --- | ---: | ---: |',
      ...browserReport.comparisons.map(
        (item) =>
          `| ${item.candidate} | ${item.reference} | ${item.workload} | ${item.ratio.median}× | ${item.ratio.confidence95.low}–${item.ratio.confidence95.high}× |`
      ),
      ''
    );
  }
  return `${lines.join('\n')}\n`;
}

async function writeBenchmarkReport(currentReport) {
  await writeAtomic(resolve(reportRoot, 'summary.md'), markdownSummary(currentReport));
  await writeAtomic(resolve(reportRoot, 'samples.csv'), samplesCsv(currentReport));
  // Treat report.json as the checkpoint commit marker after its derived files are durable.
  await writeAtomic(
    resolve(reportRoot, 'report.json'),
    `${JSON.stringify(currentReport, null, 2)}\n`
  );
}

async function writeAtomic(file, contents) {
  const temporaryFile = `${file}.tmp`;
  await writeFile(temporaryFile, contents);
  await rename(temporaryFile, file);
}

async function closeActiveBrowser() {
  if (!browser) return;
  const activeBrowser = browser;
  browser = undefined;
  try {
    await withTimeout(activeBrowser.close(), 10_000, 'browser shutdown');
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
  }
}

function samplesCsv(report) {
  const rows = [['browser', 'run_id', 'source', 'boundary', 'workload', 'unit', 'sample', 'value']];
  for (const browserReport of report.browsers) {
    for (const item of browserReport.cases) {
      item.summary.samples.forEach((value, index) => {
        rows.push([
          browserReport.name,
          item.runId,
          item.source,
          item.boundary,
          item.workload,
          item.unit,
          String(index),
          String(value),
        ]);
      });
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
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

function contentType(file) {
  const extension = extname(file);
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.wasm') return 'application/wasm';
  if (extension === '.map' || extension === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function round(value) {
  return Number(value.toFixed(3));
}

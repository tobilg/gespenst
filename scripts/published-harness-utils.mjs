import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export const PUBLISHED_SCENARIOS = Object.freeze({
  '@gespenst/bashkit': 'browser-shell',
  '@gespenst/clipboard': 'native-addons',
  '@gespenst/core': 'native-and-headless',
  '@gespenst/react': 'framework-bindings',
  '@gespenst/search': 'native-addons',
  '@gespenst/serialize': 'native-addons',
  '@gespenst/shell': 'browser-shell',
  '@gespenst/svelte': 'framework-bindings',
  '@gespenst/themes': 'native-addons',
  '@gespenst/vue': 'framework-bindings',
  '@gespenst/web-fonts': 'native-addons',
  '@gespenst/web-links': 'native-addons',
  '@gespenst/websocket': 'websocket-and-pty',
  '@gespenst/xterm': 'xterm-compatibility',
});

export const EXTERNAL_CONSUMER_DEPENDENCIES = Object.freeze({
  '@fontsource/ibm-plex-mono': '5.3.0',
  '@types/react': '19.1.11',
  '@types/react-dom': '19.1.11',
  '@xterm/addon-attach': '0.12.0',
  '@xterm/addon-fit': '0.11.0',
  '@xterm/addon-search': '0.16.0',
  '@xterm/addon-serialize': '0.14.0',
  '@xterm/addon-web-links': '0.12.0',
  react: '19.1.1',
  'react-dom': '19.1.1',
  svelte: '5.55.7',
  vue: '3.5.21',
});

export function parsePublishedHarnessArgs(argv) {
  const command = argv[0] ?? 'test';
  if (command !== 'test' && command !== 'dev') {
    throw new Error(`Expected harness command "test" or "dev"; received ${command}`);
  }
  const options = {
    command,
    selector: 'latest',
    browsers: ['chromium', 'firefox', 'webkit', 'mobile-chromium', 'mobile-webkit'],
    host: '127.0.0.1',
    keep: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--keep') {
      options.keep = true;
      continue;
    }
    if (argument === '--host') {
      options.host = '0.0.0.0';
      continue;
    }
    if (argument === '--selector' || argument === '--browser') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--selector') options.selector = value;
      else options.browsers = value === 'all' ? options.browsers : value.split(',');
      continue;
    }
    if (argument?.startsWith('--host=')) {
      options.host = argument.slice('--host='.length);
      continue;
    }
    throw new Error(`Unknown published harness option: ${argument}`);
  }
  const allowedBrowsers = new Set([
    'chromium',
    'firefox',
    'webkit',
    'mobile-chromium',
    'mobile-webkit',
  ]);
  for (const browser of options.browsers) {
    if (!allowedBrowsers.has(browser)) throw new Error(`Unsupported harness browser: ${browser}`);
  }
  if (!options.selector.trim()) throw new Error('Published package selector cannot be empty');
  if (!options.host.trim()) throw new Error('Harness host cannot be empty');
  return options;
}

export function assertScenarioCoverage(packageNames) {
  const expected = new Set(packageNames);
  const configured = new Set(Object.keys(PUBLISHED_SCENARIOS));
  const missing = [...expected].filter((name) => !configured.has(name)).sort();
  const stale = [...configured].filter((name) => !expected.has(name)).sort();
  if (missing.length || stale.length) {
    throw new Error(
      [
        missing.length ? `Packages without published scenarios: ${missing.join(', ')}` : '',
        stale.length ? `Stale published scenarios: ${stale.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
}

export function parseNpmViewMetadata(specifier, stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm returned invalid metadata for ${specifier}`, { cause: error });
  }
  const name = value?.name;
  const version = value?.version;
  const integrity = value?.['dist.integrity'];
  const tarball = value?.['dist.tarball'];
  if (
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    typeof integrity !== 'string' ||
    typeof tarball !== 'string' ||
    !tarball.startsWith('https://registry.npmjs.org/')
  ) {
    throw new Error(`npm metadata for ${specifier} is incomplete or uses an unexpected registry`);
  }
  return { name, version, integrity, tarball };
}

export async function resolveRegistryPackage(name, selector, attempts = 4) {
  const specifier = `${name}@${selector}`;
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { stdout } = await execute(
        'npm',
        ['view', specifier, 'name', 'version', 'dist.integrity', 'dist.tarball', '--json'],
        { maxBuffer: 1024 * 1024 }
      );
      const metadata = parseNpmViewMetadata(specifier, stdout);
      if (metadata.name !== name) {
        throw new Error(`npm resolved ${specifier} as unexpected package ${metadata.name}`);
      }
      return metadata;
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
    }
  }
  throw new Error(`Unable to resolve ${specifier} from npm`, { cause: failure });
}

export async function verifyRegistryInstallation(consumerRoot, packages) {
  const root = `${await realpath(consumerRoot)}${sep}`;
  const installed = [];
  for (const expected of packages) {
    const manifestPath = resolve(consumerRoot, 'node_modules', expected.name, 'package.json');
    const installedPath = await realpath(manifestPath);
    if (!installedPath.startsWith(root)) {
      throw new Error(`${expected.name} resolved outside the isolated consumer: ${installedPath}`);
    }
    const manifest = JSON.parse(await readFile(installedPath, 'utf8'));
    if (manifest.name !== expected.name || manifest.version !== expected.version) {
      throw new Error(
        `${expected.name} installed as ${String(manifest.name)}@${String(manifest.version)}; expected ${expected.version}`
      );
    }
    installed.push({ ...expected, path: installedPath });
  }
  const lockfile = await readFile(resolve(consumerRoot, 'pnpm-lock.yaml'), 'utf8');
  for (const protocol of ['workspace:', 'link:', 'file:']) {
    const localSpecifier = new RegExp(`^\\s+specifier:\\s+['"]?${protocol}`, 'mu');
    const localVersion = new RegExp(`^\\s+version:\\s+['"]?${protocol}`, 'mu');
    const localResolution = new RegExp(`^\\s+resolution:.*${protocol}`, 'mu');
    if (
      localSpecifier.test(lockfile) ||
      localVersion.test(lockfile) ||
      localResolution.test(lockfile)
    ) {
      throw new Error(`Isolated consumer lockfile contains forbidden local protocol ${protocol}`);
    }
  }
  return installed;
}

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarizeSamples(values) {
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    minimum: values.length ? Math.min(...values) : 0,
    maximum: values.length ? Math.max(...values) : 0,
    samples: [...values],
  };
}

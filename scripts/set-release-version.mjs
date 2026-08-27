import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverPublicPackages } from './release-utils.mjs';

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DEPENDENCY_GROUPS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** Updates the private workspace root and every public package to one stable version. */
export async function setReleaseVersion(root, version) {
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(`Release version must be stable semver in the form X.Y.Z; received ${version}`);
  }

  const rootPath = resolve(root, 'package.json');
  const rootManifest = JSON.parse(await readFile(rootPath, 'utf8'));
  const publicPackages = await discoverPublicPackages(root);
  const publicNames = new Set(publicPackages.map(({ manifest }) => manifest.name));
  const manifests = [
    { manifest: rootManifest, path: rootPath },
    ...publicPackages.map(({ manifest, packageRoot }) => ({
      manifest,
      path: resolve(packageRoot, 'package.json'),
    })),
  ];

  for (const { manifest } of manifests) {
    manifest.version = version;
    for (const group of DEPENDENCY_GROUPS) {
      const dependencies = manifest[group];
      if (!dependencies) continue;
      for (const [name, range] of Object.entries(dependencies)) {
        if (!publicNames.has(name) || range.startsWith('workspace:')) continue;
        dependencies[name] = updateRange(range, version, name);
      }
    }
  }

  await Promise.all(
    manifests.map(({ manifest, path }) => writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`))
  );
  return { packageCount: publicPackages.length, version };
}

function updateRange(range, version, packageName) {
  if (range.startsWith('^')) return `^${version}`;
  if (range.startsWith('~')) return `~${version}`;
  if (STABLE_SEMVER.test(range)) return version;
  throw new Error(`Unsupported internal dependency range ${range} for ${packageName}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = resolve(import.meta.dirname, '..');
  const version = process.argv.slice(2).find((argument) => argument !== '--') ?? '';
  const result = await setReleaseVersion(root, version);
  console.log(
    `Set the workspace root and ${result.packageCount} public packages to ${result.version}.`
  );
}

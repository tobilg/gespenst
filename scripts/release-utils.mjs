import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const EXPECTED_REPOSITORY = 'git+https://github.com/tobilg/gespenst.git';

export async function discoverPublicPackages(root) {
  const packagesRoot = resolve(root, 'packages');
  const packages = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = resolve(packagesRoot, entry.name);
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
    if (!manifest.private) packages.push({ manifest, packageRoot });
  }
  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export async function validateRelease(root, tag) {
  const errors = [];
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(tag ?? '');
  const version = match?.slice(1).join('.') ?? null;
  if (!version)
    errors.push(`Release tag must be stable semver in the form vX.Y.Z; received ${tag}`);

  const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (version && rootManifest.version !== version) {
    errors.push(`Workspace version ${rootManifest.version} does not match tag ${tag}`);
  }

  const publicPackages = await discoverPublicPackages(root);
  for (const { manifest } of publicPackages) {
    if (version && manifest.version !== version) {
      errors.push(`${manifest.name} is ${manifest.version}; expected ${version}`);
    }
    if (manifest.repository?.url !== EXPECTED_REPOSITORY) {
      errors.push(`${manifest.name} repository must be ${EXPECTED_REPOSITORY}`);
    }
  }

  return { errors, publicPackages, version };
}

export function sortPackagesForPublish(packages) {
  const byName = new Map(packages.map((item) => [item.manifest.name, item]));
  const dependencies = new Map();
  for (const item of packages) {
    const names = new Set();
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(item.manifest[group] ?? {})) {
        if (byName.has(name) && name !== item.manifest.name) names.add(name);
      }
    }
    dependencies.set(item.manifest.name, names);
  }

  const pending = new Set(byName.keys());
  const ordered = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((name) =>
        [...(dependencies.get(name) ?? [])].every((dependency) => !pending.has(dependency))
      )
      .sort();
    if (ready.length === 0) {
      throw new Error(`Circular internal package dependencies: ${[...pending].sort().join(', ')}`);
    }
    for (const name of ready) {
      ordered.push(byName.get(name));
      pending.delete(name);
    }
  }
  return ordered;
}

export async function packPublicPackages(root, destination) {
  await mkdir(destination, { recursive: true });
  const packages = await discoverPublicPackages(root);
  const packed = [];
  for (const item of packages) {
    const before = new Set(await readdir(destination));
    await execute(
      'pnpm',
      ['pack', '--pack-destination', destination, '--config.ignore-scripts=true'],
      { cwd: item.packageRoot, maxBuffer: 10 * 1024 * 1024 }
    );
    const archive = (await readdir(destination)).find(
      (file) => file.endsWith('.tgz') && !before.has(file)
    );
    if (!archive) throw new Error(`pnpm pack did not produce an archive for ${item.manifest.name}`);
    const bytes = await readFile(resolve(destination, archive));
    packed.push({
      ...item,
      archive,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  const ordered = sortPackagesForPublish(packed);
  const plan = ordered.map(({ archive, integrity, manifest, sha256 }) => ({
    name: manifest.name,
    version: manifest.version,
    archive,
    integrity,
    sha256,
  }));
  await writeFile(resolve(destination, 'publish-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(
    resolve(destination, 'publish-plan.tsv'),
    `${plan.map((item) => [item.name, item.version, item.archive, item.integrity].join('\t')).join('\n')}\n`
  );
  await writeFile(
    resolve(destination, 'SHA256SUMS'),
    `${plan.map((item) => `${item.sha256}  ${basename(item.archive)}`).join('\n')}\n`
  );
  return { packages: packed, plan };
}

export { EXPECTED_REPOSITORY };

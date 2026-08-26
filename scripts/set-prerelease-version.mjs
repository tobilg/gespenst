import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/u.test(version)) {
  throw new Error('Usage: node scripts/set-prerelease-version.mjs <semver-prerelease>');
}

const root = resolve(import.meta.dirname, '..');
const packageNames = await readdir(resolve(root, 'packages'));
for (const directory of packageNames) {
  const path = resolve(root, 'packages', directory, 'package.json');
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }
  const manifest = JSON.parse(source);
  manifest.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (dependency.startsWith('@gespenst/')) manifest[field][dependency] = `^${version}`;
    }
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

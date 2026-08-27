import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setReleaseVersion } from './set-release-version.mjs';

describe('release versioning', () => {
  it('updates the root, public packages, and explicit internal ranges', async () => {
    const root = await fixture();
    try {
      await expect(setReleaseVersion(root, '0.1.1')).resolves.toEqual({
        packageCount: 2,
        version: '0.1.1',
      });

      const workspace = await manifest(resolve(root, 'package.json'));
      const core = await manifest(resolve(root, 'packages/core/package.json'));
      const addon = await manifest(resolve(root, 'packages/addon/package.json'));
      expect(workspace.version).toBe('0.1.1');
      expect(core.version).toBe('0.1.1');
      expect(addon.version).toBe('0.1.1');
      expect(addon.dependencies['@gespenst/core']).toBe('workspace:*');
      expect(addon.peerDependencies['@gespenst/core']).toBe('^0.1.1');
      expect(addon.peerDependencies.react).toBe('>=19');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['v0.1.1', '0.1.1-next.1', '01.1.1', ''])(
    'rejects invalid version %j',
    async (version) => {
      const root = await fixture();
      try {
        await expect(setReleaseVersion(root, version)).rejects.toThrow('stable semver');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'gespenst-version-'));
  await mkdir(resolve(root, 'packages/core'), { recursive: true });
  await mkdir(resolve(root, 'packages/addon'), { recursive: true });
  await writeFile(
    resolve(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, version: '0.1.0' }, null, 2)}\n`
  );
  await writeFile(
    resolve(root, 'packages/core/package.json'),
    `${JSON.stringify({ name: '@gespenst/core', version: '0.1.0' }, null, 2)}\n`
  );
  await writeFile(
    resolve(root, 'packages/addon/package.json'),
    `${JSON.stringify(
      {
        name: '@gespenst/addon',
        version: '0.1.0',
        dependencies: { '@gespenst/core': 'workspace:*' },
        peerDependencies: { '@gespenst/core': '^0.1.0', react: '>=19' },
      },
      null,
      2
    )}\n`
  );
  return root;
}

async function manifest(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

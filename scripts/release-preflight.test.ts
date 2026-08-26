import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sortPackagesForPublish, validateRelease } from './release-utils.mjs';

describe('release preflight', () => {
  it('accepts a clean lockstep stable release', async () => {
    const root = await fixture();
    const result = await validateRelease(root, 'v0.1.0');
    expect(result.errors).toEqual([]);
    expect(result.version).toBe('0.1.0');
  });

  it('reports version, repository, fixed-group, and changeset drift together', async () => {
    const root = await fixture();
    const corePath = resolve(root, 'packages/core/package.json');
    const core = JSON.parse(await readFile(corePath, 'utf8'));
    core.version = '0.2.0';
    core.repository.url = 'https://example.test/wrong.git';
    await writeFile(corePath, JSON.stringify(core));
    await writeFile(resolve(root, '.changeset/config.json'), JSON.stringify({ fixed: [[]] }));
    await writeFile(resolve(root, '.changeset/pending.md'), 'pending');

    const result = await validateRelease(root, 'v0.1.0');
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('@gespenst/core is 0.2.0'),
        expect.stringContaining('@gespenst/core repository'),
        expect.stringContaining('@gespenst/core is missing from the fixed Changesets group'),
        expect.stringContaining('pending.md'),
      ])
    );
  });

  it('rejects non-stable tags', async () => {
    const root = await fixture();
    expect((await validateRelease(root, 'v0.1.0-next.1')).errors[0]).toContain('stable semver');
  });

  it('orders internal dependencies before their consumers', () => {
    const core = item('@gespenst/core');
    const addon = item('@gespenst/addon', { '@gespenst/core': '^0.1.0' });
    expect(sortPackagesForPublish([addon, core]).map((entry) => entry.manifest.name)).toEqual([
      '@gespenst/core',
      '@gespenst/addon',
    ]);
  });
});

async function fixture(): Promise<string> {
  const root = resolve(process.env.TMPDIR ?? '/tmp', `gespenst-release-${crypto.randomUUID()}`);
  await mkdir(resolve(root, '.changeset'), { recursive: true });
  await mkdir(resolve(root, 'packages/core'), { recursive: true });
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  await writeFile(
    resolve(root, 'packages/core/package.json'),
    JSON.stringify({
      name: '@gespenst/core',
      version: '0.1.0',
      repository: { url: 'git+https://github.com/tobilg/gespenst.git' },
    })
  );
  await writeFile(
    resolve(root, '.changeset/config.json'),
    JSON.stringify({ fixed: [['@gespenst/core']] })
  );
  return root;
}

function item(name: string, dependencies: Record<string, string> = {}) {
  return { manifest: { name, dependencies }, packageRoot: `/tmp/${name}` };
}

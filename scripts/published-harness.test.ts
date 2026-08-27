import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertScenarioCoverage,
  PUBLISHED_SCENARIOS,
  parseNpmViewMetadata,
  parsePublishedHarnessArgs,
  percentile,
  summarizeSamples,
  verifyRegistryInstallation,
} from './published-harness-utils.mjs';

describe('published package harness', () => {
  it('parses defaults and explicit consumer options', () => {
    expect(parsePublishedHarnessArgs(['test'])).toMatchObject({
      command: 'test',
      selector: 'latest',
      host: '127.0.0.1',
      keep: false,
    });
    expect(
      parsePublishedHarnessArgs([
        'dev',
        '--',
        '--selector',
        '0.1.1',
        '--browser',
        'chromium,webkit',
        '--host',
        '--keep',
      ])
    ).toEqual({
      command: 'dev',
      selector: '0.1.1',
      browsers: ['chromium', 'webkit'],
      host: '0.0.0.0',
      keep: true,
    });
  });

  it('requires every published package to have one scenario', () => {
    expect(() => assertScenarioCoverage(Object.keys(PUBLISHED_SCENARIOS))).not.toThrow();
    expect(() => assertScenarioCoverage(['@gespenst/core', '@gespenst/new-addon'])).toThrow(
      'Packages without published scenarios: @gespenst/new-addon'
    );
  });

  it('validates npm metadata and its registry origin', () => {
    expect(
      parseNpmViewMetadata(
        '@gespenst/core@latest',
        JSON.stringify({
          name: '@gespenst/core',
          version: '0.1.1',
          'dist.integrity': 'sha512-value',
          'dist.tarball': 'https://registry.npmjs.org/@gespenst/core/-/core-0.1.1.tgz',
        })
      )
    ).toMatchObject({ name: '@gespenst/core', version: '0.1.1' });
    expect(() =>
      parseNpmViewMetadata(
        '@gespenst/core@latest',
        JSON.stringify({
          name: '@gespenst/core',
          version: '0.1.1',
          'dist.integrity': 'sha512-value',
          'dist.tarball': 'https://example.test/core.tgz',
        })
      )
    ).toThrow('unexpected registry');
  });

  it('calculates deterministic median and p95 summaries', () => {
    expect(percentile([5, 1, 4, 3, 2], 0.5)).toBe(3);
    expect(summarizeSamples([10, 30, 20])).toEqual({
      median: 20,
      p95: 30,
      minimum: 10,
      maximum: 30,
      samples: [10, 30, 20],
    });
  });

  it('rejects package symlinks that escape the isolated consumer', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'gespenst-harness-'));
    const consumer = resolve(base, 'consumer');
    const external = resolve(base, 'external');
    try {
      await mkdir(resolve(consumer, 'node_modules/@gespenst'), { recursive: true });
      await mkdir(external, { recursive: true });
      await writeFile(
        resolve(external, 'package.json'),
        JSON.stringify({ name: '@gespenst/core', version: '0.1.1' })
      );
      await writeFile(resolve(consumer, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await symlink(external, resolve(consumer, 'node_modules/@gespenst/core'));
      await expect(
        verifyRegistryInstallation(consumer, [
          {
            name: '@gespenst/core',
            version: '0.1.1',
            integrity: 'sha512-value',
            tarball: 'https://registry.npmjs.org/core.tgz',
          },
        ])
      ).rejects.toThrow('resolved outside');
      expect(await realpath(external)).toContain('gespenst-harness-');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('distinguishes pnpm settings from actual local package protocols', async () => {
    const base = await mkdtemp(resolve(tmpdir(), 'gespenst-harness-'));
    const consumer = resolve(base, 'consumer');
    const packageRoot = resolve(consumer, 'node_modules/@gespenst/core');
    try {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        resolve(packageRoot, 'package.json'),
        JSON.stringify({ name: '@gespenst/core', version: '0.1.1' })
      );
      await writeFile(
        resolve(consumer, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nsettings:\n  excludeLinksFromLockfile: false\n"
      );
      await expect(
        verifyRegistryInstallation(consumer, [
          {
            name: '@gespenst/core',
            version: '0.1.1',
            integrity: 'sha512-value',
            tarball: 'https://registry.npmjs.org/core.tgz',
          },
        ])
      ).resolves.toHaveLength(1);
      await writeFile(
        resolve(consumer, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@gespenst/core':\n        specifier: 0.1.1\n        version: link:../../packages/core\n"
      );
      await expect(
        verifyRegistryInstallation(consumer, [
          {
            name: '@gespenst/core',
            version: '0.1.1',
            integrity: 'sha512-value',
            tarball: 'https://registry.npmjs.org/core.tgz',
          },
        ])
      ).rejects.toThrow('forbidden local protocol link:');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

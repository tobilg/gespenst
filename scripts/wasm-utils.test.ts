import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import wabtModule from 'wabt';
import {
  diffGhosttyBuilds,
  exportSignatures,
  formatBuildDiff,
  resolveTipRelease,
  SIGNATURE_URL,
  SOURCE_URL,
  verifyMinisign,
} from './wasm-utils.mjs';

const COMMIT = '919dca5c848d43a489a4cb2e1feade016f0fa2db';

describe('minisign verification', () => {
  const file = new TextEncoder().encode('ghostty wasm bytes');

  it('accepts a prehashed signature for the expected file', () => {
    const { publicKey, signature } = signMinisign(file);
    expect(verifyMinisign(file, signature, { fileName: 'ghostty-vt.wasm', publicKey })).toEqual({
      trustedComment: 'timestamp:1793129099\tfile:ghostty-vt.wasm\thashed',
      signedAt: '2026-10-27T19:24:59.000Z',
    });
  });

  it('rejects modified bytes', () => {
    const { publicKey, signature } = signMinisign(file);
    const modified = new TextEncoder().encode('ghostty wasm bytez');
    expect(() =>
      verifyMinisign(modified, signature, { fileName: 'ghostty-vt.wasm', publicKey })
    ).toThrow('does not match');
  });

  it('rejects a modified trusted comment', () => {
    const { publicKey, signature } = signMinisign(file);
    const modified = signature.replace('file:ghostty-vt.wasm', 'file:ghostty-vt-small.wasm');
    expect(() =>
      verifyMinisign(file, modified, { fileName: 'ghostty-vt.wasm', publicKey })
    ).toThrow('trusted comment');
  });

  it('rejects a signature for another file', () => {
    const { publicKey, signature } = signMinisign(file, { fileName: 'ghostty-vt-small.wasm' });
    expect(() =>
      verifyMinisign(file, signature, { fileName: 'ghostty-vt.wasm', publicKey })
    ).toThrow('ghostty-vt-small.wasm');
  });

  it('rejects signatures from another key', () => {
    const { signature } = signMinisign(file);
    const { publicKey } = signMinisign(file);
    expect(() =>
      verifyMinisign(file, signature, { fileName: 'ghostty-vt.wasm', publicKey })
    ).toThrow('different key');
  });

  it('rejects legacy signatures over the raw file', () => {
    const { publicKey, signature } = signMinisign(file, { prehashed: false });
    expect(() =>
      verifyMinisign(file, signature, { fileName: 'ghostty-vt.wasm', publicKey })
    ).toThrow('prehashed');
  });
});

describe('tip release metadata', () => {
  it('selects the WASM and signature assets with their digests', () => {
    expect(resolveTipRelease(release())).toEqual({
      commit: COMMIT,
      wasm: {
        name: 'ghostty-vt.wasm',
        url: SOURCE_URL,
        size: 1189912,
        sha256: 'a'.repeat(64),
        updatedAt: '2026-10-27T19:25:04Z',
      },
      signature: {
        name: 'ghostty-vt.wasm.minisig',
        url: SIGNATURE_URL,
        size: 310,
        sha256: 'b'.repeat(64),
        updatedAt: '2026-10-27T19:25:04Z',
      },
    });
  });

  it.each([
    ['an abbreviated commit', { target_commitish: '919dca5' }, 'full commit SHA'],
    ['another release', { tag_name: 'v1.4.0' }, 'tip release'],
  ])('rejects %s', (_label, override, message) => {
    expect(() => resolveTipRelease({ ...release(), ...override })).toThrow(message);
  });

  it.each([
    ['a missing digest', { digest: null }, 'no SHA-256 digest'],
    ['an incomplete upload', { state: 'starter' }, 'not fully uploaded'],
    ['an unexpected URL', { browser_download_url: 'https://example.test/x.wasm' }, 'download URL'],
  ])('rejects a WASM asset with %s', (_label, override, message) => {
    const value = release();
    value.assets[0] = { ...value.assets[0], ...override };
    expect(() => resolveTipRelease(value)).toThrow(message);
  });

  it('requires the signature asset', () => {
    const value = release();
    value.assets.pop();
    expect(() => resolveTipRelease(value)).toThrow('ghostty-vt.wasm.minisig');
  });
});

describe('build comparison', () => {
  it('reads function signatures and other export kinds', async () => {
    const signatures = exportSignatures(
      await wat(`(module
        (memory (export "memory") 1)
        (func (export "write") (param i32 i32) (result i32) i32.const 0)
        (func (export "free") (param i32)))`)
    );
    expect(Object.fromEntries(signatures)).toEqual({
      memory: 'memory',
      write: '(i32, i32) -> (i32)',
      free: '(i32) -> ()',
    });
  });

  it('reports export and ABI changes between builds', async () => {
    const previous = {
      signatures: exportSignatures(
        await wat(`(module
          (func (export "kept") (param i32) (result i32) i32.const 0)
          (func (export "changed") (param i32))
          (func (export "removed")))`)
      ),
      manifest: {
        types: {
          Option: { kind: 'enum', size: 4, align: 4, values: { OLD: 0, MOVED: 1 } },
          Struct: {
            kind: 'struct',
            size: 8,
            align: 4,
            fields: { a: { type: 'u32', offset: 0, size: 4 } },
          },
          Gone: { kind: 'opaque', size: 4, align: 4 },
        },
      },
    };
    const next = {
      signatures: exportSignatures(
        await wat(`(module
          (func (export "kept") (param i32) (result i32) i32.const 0)
          (func (export "changed") (param i32 i32))
          (func (export "added")))`)
      ),
      manifest: {
        types: {
          Option: { kind: 'enum', size: 4, align: 4, values: { MOVED: 2, NEW: 3 } },
          Struct: {
            kind: 'struct',
            size: 12,
            align: 4,
            fields: {
              a: { type: 'u32', offset: 4, size: 4 },
              b: { type: 'u32', offset: 8, size: 4 },
            },
          },
          Fresh: { kind: 'opaque', size: 4, align: 4 },
        },
      },
    };

    const diff = diffGhosttyBuilds(previous, next);
    expect(diff).toEqual({
      exportsAdded: ['added'],
      exportsRemoved: ['removed'],
      signaturesChanged: [{ name: 'changed', before: '(i32) -> ()', after: '(i32, i32) -> ()' }],
      typesAdded: ['Fresh'],
      typesRemoved: ['Gone'],
      typesChanged: [
        { name: 'Option', changes: ['-value OLD', 'value MOVED 1 -> 2', '+value NEW=3'] },
        { name: 'Struct', changes: ['size 8 -> 12', 'field a u32@0/4 -> u32@4/4', '+field b'] },
      ],
    });
    expect(formatBuildDiff(diff)).toContain('Changed export signatures (1):\n  changed:');
    expect(formatBuildDiff(diffGhosttyBuilds(previous, previous))).toBe(
      'No export or ABI changes.'
    );
  });

  it('rejects modules with imports', async () => {
    const bytes = await wat('(module (import "host" "f" (func)))');
    expect(() => exportSignatures(bytes)).toThrow('no imports');
  });
});

function signMinisign(
  file: Uint8Array,
  { fileName = 'ghostty-vt.wasm', prehashed = true } = {}
): { publicKey: string; signature: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const message = prehashed ? createHash('blake2b512').update(file).digest() : Buffer.from(file);
  const value = sign(null, message, privateKey);
  const trustedComment = `timestamp:1793129099\tfile:${fileName}\thashed`;
  const globalSignature = sign(
    null,
    Buffer.concat([value, Buffer.from(trustedComment)]),
    privateKey
  );
  const algorithm = Buffer.from(prehashed ? 'ED' : 'Ed', 'latin1');
  return {
    publicKey: Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, rawPublicKey]).toString('base64'),
    signature: [
      'untrusted comment: signature from minisign secret key',
      Buffer.concat([algorithm, keyId, value]).toString('base64'),
      `trusted comment: ${trustedComment}`,
      globalSignature.toString('base64'),
      '',
    ].join('\n'),
  };
}

async function wat(source: string): Promise<Uint8Array> {
  const wabt = await wabtModule();
  const module = wabt.parseWat('fixture.wat', source);
  try {
    return module.toBinary({}).buffer;
  } finally {
    module.destroy();
  }
}

function release() {
  const asset = (name: string, browser_download_url: string, size: number, digest: string) => ({
    name,
    browser_download_url,
    size,
    digest: `sha256:${digest.repeat(64)}`,
    state: 'uploaded',
    updated_at: '2026-10-27T19:25:04Z',
  });
  return {
    tag_name: 'tip',
    target_commitish: COMMIT,
    assets: [
      asset('ghostty-vt.wasm', SOURCE_URL, 1189912, 'a'),
      asset('ghostty-vt.wasm.minisig', SIGNATURE_URL, 310, 'b'),
    ],
  };
}

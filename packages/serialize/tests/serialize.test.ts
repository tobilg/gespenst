import type { BrowserTerminal } from '@gespenst/core';
import { describe, expect, it, vi } from 'vitest';
import { SerializeAddon } from '../src';

describe('@gespenst/serialize', () => {
  it('round-trips snapshots with deterministic metadata and releases activation', async () => {
    const snapshot = new Uint8Array([1, 2, 3]);
    const restore = vi.fn(async () => undefined);
    const addon = new SerializeAddon();
    addon.activate({ snapshot: async () => snapshot, restore } as unknown as BrowserTerminal);
    const createdAt = new Date('2026-01-02T03:04:05.000Z');

    const serialized = await addon.serialize({ createdAt });
    const metadata = await addon.restore(serialized);
    expect(metadata.createdAt).toBe(createdAt.toISOString());
    expect(metadata.format).toBe(1);
    expect(restore).toHaveBeenCalledWith(snapshot);

    addon.dispose();
    await expect(addon.serialize()).rejects.toThrow('not active');
    await expect(addon.restore(serialized)).rejects.toThrow('not active');
  });

  it('rejects unsupported, truncated, malformed, and ABI-incompatible envelopes', async () => {
    const addon = new SerializeAddon();
    addon.activate({
      snapshot: async () => new Uint8Array([1]),
      restore: async () => undefined,
    } as unknown as BrowserTerminal);
    await expect(addon.restore(new Uint8Array([1, 2, 3]))).rejects.toThrow('Unsupported');

    const valid = await addon.serialize();
    const truncated = valid.slice(0, 9);
    new DataView(truncated.buffer).setUint32(5, 100, true);
    await expect(addon.restore(truncated)).rejects.toThrow('Truncated');

    const malformed = valid.slice();
    const headerLength = new DataView(malformed.buffer).getUint32(5, true);
    malformed.fill(0x78, 9, 9 + headerLength);
    await expect(addon.restore(malformed)).rejects.toThrow();

    const incompatible = valid.slice();
    const metadata = envelopeMetadata(incompatible);
    metadata.format = 2;
    rewriteMetadata(incompatible, metadata);
    await expect(addon.restore(incompatible)).rejects.toThrow('Incompatible');
  });

  it('rejects snapshots from a different exact Ghostty build', async () => {
    const restore = vi.fn(async () => undefined);
    const terminal = {
      snapshot: async () => new Uint8Array([1, 2, 3]),
      restore,
    } as unknown as BrowserTerminal;
    const addon = new SerializeAddon();
    addon.activate(terminal);
    const serialized = await addon.serialize();
    const headerLength = new DataView(
      serialized.buffer,
      serialized.byteOffset,
      serialized.byteLength
    ).getUint32(5, true);
    const headerStart = 9;
    const metadata = envelopeMetadata(serialized);
    metadata.ghostty.sha256 = '0'.repeat(64);
    const header = new TextEncoder().encode(JSON.stringify(metadata));
    expect(header).toHaveLength(headerLength);
    serialized.set(header, headerStart);

    await expect(addon.restore(serialized)).rejects.toThrow('Incompatible');
    expect(restore).not.toHaveBeenCalled();
  });
});

function envelopeMetadata(serialized: Uint8Array) {
  const headerLength = new DataView(
    serialized.buffer,
    serialized.byteOffset,
    serialized.byteLength
  ).getUint32(5, true);
  return JSON.parse(new TextDecoder().decode(serialized.subarray(9, 9 + headerLength)));
}

function rewriteMetadata(serialized: Uint8Array, metadata: unknown): void {
  const headerLength = new DataView(
    serialized.buffer,
    serialized.byteOffset,
    serialized.byteLength
  ).getUint32(5, true);
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  expect(header).toHaveLength(headerLength);
  serialized.set(header, 9);
}

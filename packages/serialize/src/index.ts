import {
  type BrowserTerminal,
  GHOSTTY_BUILD,
  type GhosttyBuildMetadata,
  type TerminalAddon,
} from '@gespenst/core';

const MAGIC = new Uint8Array([0x47, 0x54, 0x54, 0x59, 1]);

/** Version and Ghostty build information stored ahead of every snapshot. */
export interface SerializedTerminalMetadata {
  /** Serialization format version. */
  readonly format: 1;
  /** ISO-8601 timestamp at which the snapshot was created. */
  readonly createdAt: string;
  /** Ghostty build identity required to validate snapshot compatibility. */
  readonly ghostty: Pick<
    GhosttyBuildMetadata,
    'ghosttyVersion' | 'ghosttyCommit' | 'abiSchema' | 'sha256'
  >;
}

/** Options used when creating a serialized snapshot. */
export interface SerializeOptions {
  /** Timestamp to embed; defaults to the current time. */
  readonly createdAt?: Date;
}

/** Creates and restores versioned binary terminal snapshots. */
export class SerializeAddon implements TerminalAddon {
  private terminal: BrowserTerminal | null = null;

  /** Attaches the addon to a terminal. Called by `terminal.loadAddon()`. */
  activate(terminal: BrowserTerminal): void {
    this.terminal = terminal;
  }

  /** Serializes metadata and the terminal snapshot into a portable byte array. */
  async serialize(options: SerializeOptions = {}): Promise<Uint8Array> {
    if (!this.terminal) throw new Error('SerializeAddon is not active');
    const snapshot = await this.terminal.snapshot();
    const metadata: SerializedTerminalMetadata = {
      format: 1,
      createdAt: (options.createdAt ?? new Date()).toISOString(),
      ghostty: {
        ghosttyVersion: GHOSTTY_BUILD.ghosttyVersion,
        ghosttyCommit: GHOSTTY_BUILD.ghosttyCommit,
        abiSchema: GHOSTTY_BUILD.abiSchema,
        sha256: GHOSTTY_BUILD.sha256,
      },
    };
    const header = new TextEncoder().encode(JSON.stringify(metadata));
    const output = new Uint8Array(MAGIC.length + 4 + header.length + snapshot.length);
    output.set(MAGIC);
    new DataView(output.buffer).setUint32(MAGIC.length, header.length, true);
    output.set(header, MAGIC.length + 4);
    output.set(snapshot, MAGIC.length + 4 + header.length);
    return output;
  }

  /** Validates and restores a serialized snapshot, returning its decoded metadata. */
  async restore(data: Uint8Array): Promise<SerializedTerminalMetadata> {
    if (!this.terminal) throw new Error('SerializeAddon is not active');
    if (!MAGIC.every((value, index) => data[index] === value))
      throw new Error('Unsupported gespenst serialization');
    const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(
      MAGIC.length,
      true
    );
    const headerStart = MAGIC.length + 4;
    const snapshotStart = headerStart + headerLength;
    if (snapshotStart > data.length) throw new Error('Truncated gespenst serialization');
    const metadata = JSON.parse(
      new TextDecoder().decode(data.subarray(headerStart, snapshotStart))
    ) as SerializedTerminalMetadata;
    if (
      metadata.format !== 1 ||
      metadata.ghostty.abiSchema !== GHOSTTY_BUILD.abiSchema ||
      metadata.ghostty.sha256 !== GHOSTTY_BUILD.sha256
    )
      throw new Error('Incompatible gespenst serialization');
    await this.terminal.restore(data.subarray(snapshotStart));
    return metadata;
  }

  /** Releases the active terminal reference. */
  dispose(): void {
    this.terminal = null;
  }
}

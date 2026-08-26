import type { TerminalTransport } from '@gespenst/core';
import type { WasmerProcessInstance, WasmerStreamChunk } from './types.js';

/** Chunks collected in a single pull before the drain yields back to the consumer. */
const drainChunkLimit = 4096;
/** Bytes collected in a single pull before the drain yields back to the consumer. */
const drainByteLimit = 256 * 1024;
/** Race result meaning no reader had bytes ready without waiting. */
const drainIdle = Symbol('wasmer-drain-idle');

interface TransportBridge {
  readonly transport: TerminalTransport;
  closeInput(): Promise<void>;
  abortInput(reason?: unknown): Promise<void>;
  cancelOutput(reason?: unknown): Promise<void>;
}

/**
 * Adapts a running Wasmer instance to gespenst's native byte transport. Process output
 * receives the default PTY `ONLCR` behavior because the Wasmer SDK exposes pipes, not a TTY.
 */
export function wasmerProcessTransport(instance: WasmerProcessInstance): TerminalTransport {
  return createTransportBridge(instance).transport;
}

export function createTransportBridge(instance: WasmerProcessInstance): TransportBridge {
  const readers = [instance.stdout.getReader(), instance.stderr.getReader()];
  let outputDone = false;
  let consumerCancelled = false;
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const activeReaders = new Set(readers.keys());
  const pendingReads = new Map<
    number,
    Promise<
      | { readonly index: number; readonly result: ReadableStreamReadResult<WasmerStreamChunk> }
      | { readonly index: number; readonly error: unknown }
    >
  >();
  const encoder = new TextEncoder();
  let previousOutputByteWasCarriageReturn = false;
  let deferredError: unknown;
  let hasDeferredError = false;

  const cancelReaders = async (reason?: unknown) => {
    await Promise.all(
      readers.map(async (reader, index) => {
        if (!activeReaders.has(index)) return;
        try {
          await reader.cancel(reason);
        } catch {
          // A completed source may already be closed.
        } finally {
          activeReaders.delete(index);
          reader.releaseLock();
        }
      })
    );
    pendingReads.clear();
  };

  const scheduleRead = (index: number) => {
    if (!activeReaders.has(index) || pendingReads.has(index)) return;
    const reader = readers[index];
    if (!reader) return;
    pendingReads.set(
      index,
      reader.read().then(
        (result) => ({ index, result }),
        (error: unknown) => ({ index, error })
      )
    );
  };

  /**
   * Collects every chunk the readers can supply without waiting, so one pull delivers a whole
   * burst instead of a single chunk. The consumer pulls about once per frame and the SDK hands
   * out small chunks, so enqueuing one chunk per pull capped output at roughly one chunk per
   * frame. The caps bound how long a flooding process can hold the loop before the consumer
   * gets a turn.
   *
   * This batches; it does not order. stdout and stderr are independent pipes with no shared
   * sequencing, so a process that writes to both can still have its output interleaved. Only
   * the process can resolve that, by pointing both descriptors at one pipe the way a PTY does.
   */
  const drainAvailable = async (collect: (chunk: Uint8Array) => number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof drainIdle>((resolve) => {
      timer = setTimeout(() => resolve(drainIdle), 0);
    });
    try {
      for (let chunks = 1; chunks < drainChunkLimit; chunks += 1) {
        if (activeReaders.size === 0 || outputDone || consumerCancelled) return;
        for (const index of activeReaders) scheduleRead(index);
        const next = await Promise.race([...pendingReads.values(), idle]);
        if (next === drainIdle) return;
        pendingReads.delete(next.index);
        if ('error' in next) {
          deferredError = next.error;
          hasDeferredError = true;
          return;
        }
        if (next.result.done) {
          activeReaders.delete(next.index);
          readers[next.index]?.releaseLock();
          continue;
        }
        if (collect(toBytes(next.result.value, encoder)) >= drainByteLimit) return;
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const pullOutput = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (outputDone || consumerCancelled) {
      if (!consumerCancelled) controller.close();
      return;
    }
    if (hasDeferredError) {
      const error = deferredError;
      hasDeferredError = false;
      deferredError = undefined;
      outputDone = true;
      await cancelReaders(error);
      throw asError(error);
    }
    while (activeReaders.size > 0) {
      for (const index of activeReaders) scheduleRead(index);
      const settled = await Promise.race(pendingReads.values());
      pendingReads.delete(settled.index);
      if (outputDone || consumerCancelled) return;
      if ('error' in settled) {
        outputDone = true;
        await cancelReaders(settled.error);
        throw asError(settled.error);
      }
      if (settled.result.done) {
        const reader = readers[settled.index];
        activeReaders.delete(settled.index);
        reader?.releaseLock();
        continue;
      }
      try {
        const parts: Uint8Array[] = [];
        let total = 0;
        const collect = (chunk: Uint8Array) => {
          parts.push(chunk);
          total += chunk.byteLength;
          return total;
        };
        collect(toBytes(settled.result.value, encoder));
        await drainAvailable(collect);
        if (consumerCancelled) return;
        const merged = parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts, total);
        const normalized = normalizeTerminalNewlines(merged, previousOutputByteWasCarriageReturn);
        previousOutputByteWasCarriageReturn = normalized.endsWithCarriageReturn;
        controller.enqueue(normalized.bytes);
        return;
      } catch (error) {
        outputDone = true;
        await cancelReaders(error);
        throw error;
      }
    }
    outputDone = true;
    controller.close();
  };

  const readable = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        outputController = controller;
      },
      pull: pullOutput,
      async cancel(reason) {
        consumerCancelled = true;
        outputDone = true;
        await cancelReaders(reason);
      },
    },
    { highWaterMark: 0 }
  );

  const inputWriter = instance.stdin?.getWriter();
  let inputDone = inputWriter === undefined;
  const closeInput = async () => {
    if (inputDone || !inputWriter) return;
    inputDone = true;
    try {
      await inputWriter.close();
    } finally {
      inputWriter.releaseLock();
    }
  };
  const abortInput = async (reason?: unknown) => {
    if (inputDone || !inputWriter) return;
    inputDone = true;
    try {
      await inputWriter.abort(reason);
    } finally {
      inputWriter.releaseLock();
    }
  };
  const writable = new WritableStream<Uint8Array>({
    async write(data) {
      if (!inputWriter) throw new Error('Wasmer process has no interactive stdin');
      if (inputDone) throw new Error('Wasmer process stdin is closed');
      await inputWriter.write(data);
    },
    close: closeInput,
    abort: abortInput,
  });

  return {
    transport: { readable, writable },
    closeInput,
    abortInput,
    async cancelOutput(reason) {
      if (outputDone) return;
      outputDone = true;
      outputController?.close();
      await cancelReaders(reason);
    },
  };
}

function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

function toBytes(value: WasmerStreamChunk, encoder: TextEncoder): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`Wasmer emitted an unsupported stream chunk: ${typeof value}`);
}

function normalizeTerminalNewlines(
  bytes: Uint8Array,
  startsWithCarriageReturn: boolean
): { readonly bytes: Uint8Array; readonly endsWithCarriageReturn: boolean } {
  let previousWasCarriageReturn = startsWithCarriageReturn;
  let bareLineFeeds = 0;
  for (const byte of bytes) {
    if (byte === 0x0a && !previousWasCarriageReturn) bareLineFeeds += 1;
    previousWasCarriageReturn = byte === 0x0d;
  }
  if (bareLineFeeds === 0) {
    return { bytes, endsWithCarriageReturn: previousWasCarriageReturn };
  }

  const output = new Uint8Array(bytes.byteLength + bareLineFeeds);
  let outputOffset = 0;
  previousWasCarriageReturn = startsWithCarriageReturn;
  for (const byte of bytes) {
    if (byte === 0x0a && !previousWasCarriageReturn) output[outputOffset++] = 0x0d;
    output[outputOffset++] = byte;
    previousWasCarriageReturn = byte === 0x0d;
  }
  return { bytes: output, endsWithCarriageReturn: previousWasCarriageReturn };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

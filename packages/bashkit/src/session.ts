import type { Bash } from '@everruns/bashkit-wasm';
import type {
  BashKitShellCapabilities,
  BashKitShellExit,
  BashKitShellSession,
  BashKitShellStatus,
} from './types.js';

const encoder = new TextEncoder();
const SESSION_CAPABILITIES: BashKitShellCapabilities = Object.freeze({
  interactiveInput: true,
  filesystem: true,
  subprocesses: false,
  arbitraryWasiModules: false,
  resize: false,
  crossOriginIsolation: false,
});

/** @internal Command executor used by the stream adapter and deterministic tests. */
export interface BashKitCommandExecutor {
  execute(
    command: string,
    onOutput: (stdout: string, stderr: string) => void
  ): Promise<{ readonly stderr: string; readonly exitCode: number }>;
  cancel(): void;
  clearCancel(): void;
}

/** @internal Values used to construct the transport independently of WASM initialization. */
export interface BashKitSessionAdapterOptions {
  readonly bash: Bash;
  readonly executor: BashKitCommandExecutor;
  readonly prompt: string;
  readonly historyLimit: number;
  readonly maxBufferedOutputBytes: number;
}

/** @internal Creates a managed session around a BashKit-compatible command executor. */
export function createManagedBashKitSession(
  options: BashKitSessionAdapterOptions
): BashKitShellSession {
  const decoder = new TextDecoder();
  const history: string[] = [];
  const listeners = new Set<(status: BashKitShellStatus) => void>();
  const outputQueue: Uint8Array[] = [];
  let queuedOutputBytes = 0;
  let historyIndex = -1;
  let line = '';
  let inputBuffer = '';
  let deferredInput = '';
  let running = false;
  let closeRequested = false;
  let disposed = false;
  let consumerCancelled = false;
  let closeAfterFlush = false;
  let readableSettled = false;
  let previousOutputEndedWithCarriageReturn = false;
  let status: BashKitShellStatus = 'running';
  let sessionError: Error | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolveExit!: (result: BashKitShellExit) => void;
  let rejectExit!: (error: Error) => void;
  let exitSettled = false;
  const exit = new Promise<BashKitShellExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void exit.catch(() => undefined);

  const setStatus = (value: BashKitShellStatus) => {
    if (status === value) return;
    status = value;
    for (const listener of [...listeners]) listener(value);
  };
  const settleExit = (result: BashKitShellExit) => {
    if (exitSettled) return;
    exitSettled = true;
    resolveExit(result);
  };
  const rejectSession = (reason: unknown) => {
    if (status === 'error' || status === 'disposed' || status === 'exited') return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    sessionError = error;
    setStatus('error');
    options.executor.cancel();
    outputQueue.length = 0;
    queuedOutputBytes = 0;
    if (!readableSettled && !consumerCancelled) {
      readableSettled = true;
      controller?.error(error);
    }
    if (!exitSettled) {
      exitSettled = true;
      rejectExit(error);
    }
  };
  const drainOutput = () => {
    if (!controller || readableSettled || consumerCancelled) return;
    while (outputQueue.length > 0 && (controller.desiredSize ?? 1) > 0) {
      const chunk = outputQueue.shift();
      if (!chunk) break;
      queuedOutputBytes -= chunk.byteLength;
      controller.enqueue(chunk);
    }
    if (closeAfterFlush && outputQueue.length === 0) {
      readableSettled = true;
      controller.close();
    }
  };
  const output = (text: string) => {
    if (disposed || readableSettled || consumerCancelled || !text) return;
    let normalized = '';
    for (const character of text) {
      if (character === '\n' && !previousOutputEndedWithCarriageReturn) normalized += '\r';
      normalized += character;
      previousOutputEndedWithCarriageReturn = character === '\r';
    }
    const bytes = encoder.encode(normalized);
    if (queuedOutputBytes + bytes.byteLength > options.maxBufferedOutputBytes) {
      rejectSession(
        new Error(`BashKit output exceeded the ${options.maxBufferedOutputBytes}-byte buffer limit`)
      );
      return;
    }
    outputQueue.push(bytes);
    queuedOutputBytes += bytes.byteLength;
    drainOutput();
  };
  const finish = (result: BashKitShellExit, discardOutput = false) => {
    if (status === 'exited' || status === 'disposed' || status === 'error') return;
    if (result.reason === 'disposed') {
      disposed = true;
      setStatus('disposed');
    } else {
      setStatus('exited');
    }
    options.executor.cancel();
    options.executor.clearCancel();
    settleExit(result);
    if (consumerCancelled || readableSettled) return;
    if (discardOutput) {
      outputQueue.length = 0;
      queuedOutputBytes = 0;
    }
    closeAfterFlush = true;
    drainOutput();
  };
  const replaceInput = (next: string) => {
    line = next;
    output(`\r\x1b[2K${options.prompt}${line}`);
  };
  const showPrompt = () => output(options.prompt);
  const run = async (command: string) => {
    running = true;
    try {
      const result = await options.executor.execute(command, (stdout, stderr) => {
        output(stdout);
        if (stderr) {
          const lineFeed = stderr.endsWith('\n') ? '' : '\n';
          output(`\x1b[31m${stderr}${lineFeed}\x1b[0m`);
        }
      });
      if (result.exitCode !== 0 && !result.stderr) {
        output(`\x1b[31mexit code: ${result.exitCode}\x1b[0m\r\n`);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      output(`\x1b[31m${message}\x1b[0m\r\n`);
    } finally {
      options.executor.clearCancel();
      running = false;
      if (closeRequested) {
        finish({ code: 0, reason: 'closed' });
      } else if (!disposed && status === 'running') {
        showPrompt();
        if (deferredInput) {
          const pending = deferredInput;
          deferredInput = '';
          consume(pending);
        }
      }
    }
  };
  const submit = () => {
    const command = line;
    line = '';
    historyIndex = -1;
    output('\r\n');
    if (!command.trim()) {
      showPrompt();
      return;
    }
    const exitCommand = /^\s*exit(?:\s+([+-]?\d+))?\s*$/u.exec(command);
    if (exitCommand) {
      const parsed = Number.parseInt(exitCommand[1] ?? '0', 10);
      const code = (((Number.isFinite(parsed) ? parsed : 0) % 256) + 256) % 256;
      output('exit\r\n');
      finish({ code, reason: 'exit' });
      return;
    }
    if (options.historyLimit > 0) {
      history.push(command);
      if (history.length > options.historyLimit)
        history.splice(0, history.length - options.historyLimit);
    }
    void run(command);
  };
  const historyMove = (delta: -1 | 1) => {
    if (history.length === 0 || running) return;
    if (historyIndex < 0) historyIndex = history.length;
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + delta));
    replaceInput(historyIndex === history.length ? '' : (history[historyIndex] ?? ''));
  };
  const consume = (text: string) => {
    inputBuffer += text;
    while (inputBuffer && status === 'running') {
      if (running) {
        if (inputBuffer.includes('\x03')) {
          options.executor.cancel();
          output('^C\r\n');
          inputBuffer = inputBuffer.replaceAll('\x03', '');
        }
        deferredInput += inputBuffer;
        inputBuffer = '';
        return;
      }
      if (inputBuffer[0] === '\x1b') {
        if (inputBuffer.length < 3) return;
        const sequence = inputBuffer.slice(0, 3);
        inputBuffer = inputBuffer.slice(3);
        if (sequence === '\x1b[A') historyMove(-1);
        else if (sequence === '\x1b[B') historyMove(1);
        continue;
      }
      const character = Array.from(inputBuffer)[0];
      if (character === undefined) return;
      inputBuffer = inputBuffer.slice(character.length);
      if (character === '\r' || character === '\n') {
        submit();
      } else if (character === '\x03') {
        options.executor.cancel();
        options.executor.clearCancel();
        line = '';
        output('^C\r\n');
        showPrompt();
      } else if (character === '\x7f' || character === '\b') {
        const characters = Array.from(line);
        if (characters.length > 0) {
          characters.pop();
          line = characters.join('');
          output('\b \b');
        }
      } else if (character === '\x15') {
        replaceInput('');
      } else if (character === '\x0c') {
        output(`\x1b[2J\x1b[H${options.prompt}${line}`);
      } else if (character >= ' ' && character !== '\x7f') {
        line += character;
        output(character);
      }
    }
  };

  const readable = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        showPrompt();
      },
      pull() {
        drainOutput();
      },
      cancel() {
        consumerCancelled = true;
        finish({ code: 0, reason: 'disposed' }, true);
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength }
  );
  const writable = new WritableStream<Uint8Array>({
    write(data) {
      if (status !== 'running') throw new Error('BashKit shell is not running');
      consume(decoder.decode(data, { stream: true }));
    },
    close() {
      const trailing = decoder.decode();
      if (trailing) consume(trailing);
      closeRequested = true;
      if (running) {
        setStatus('closing');
        options.executor.cancel();
      } else {
        finish({ code: 0, reason: 'closed' });
      }
    },
    abort() {
      finish({ code: 0, reason: 'disposed' }, true);
    },
  });

  return {
    transport: { readable, writable },
    bash: options.bash,
    capabilities: SESSION_CAPABILITIES,
    get status() {
      return status;
    },
    get error() {
      return sessionError;
    },
    exit,
    async close() {
      if (status === 'disposed') throw new Error('BashKitShellSession is disposed');
      if (status === 'exited') return exit;
      closeRequested = true;
      if (running) {
        setStatus('closing');
        options.executor.cancel();
      } else {
        finish({ code: 0, reason: 'closed' });
      }
      return exit;
    },
    onStatusChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose() {
      if (status === 'disposed') return;
      if (status === 'exited') {
        disposed = true;
        listeners.clear();
        return;
      }
      finish({ code: 0, reason: 'disposed' }, true);
      listeners.clear();
    },
  };
}

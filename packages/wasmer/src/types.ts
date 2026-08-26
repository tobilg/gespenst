import type {
  Disposable,
  TerminalConnection,
  TerminalConnectionOptions,
  TerminalTransport,
} from '@gespenst/core';

/** A chunk produced by a Wasmer process output stream. */
export type WasmerStreamChunk = Uint8Array | ArrayBuffer | string;

/** A browser feature required by the Wasmer JavaScript SDK. */
export type WasmerBrowserFeature =
  | 'secure-context'
  | 'cross-origin-isolation'
  | 'shared-array-buffer'
  | 'webassembly'
  | 'web-worker'
  | 'web-streams';

/** Result of checking whether the current browser can run Wasmer WASIX processes. */
export interface WasmerBrowserSupport {
  /** Whether every required browser feature is available. */
  readonly supported: boolean;
  /** Whether the current page is a secure browser context. */
  readonly secureContext: boolean;
  /** Whether COOP and COEP have made the current page cross-origin isolated. */
  readonly crossOriginIsolated: boolean;
  /** Required features that are unavailable. */
  readonly missing: readonly WasmerBrowserFeature[];
}

/** Custom initialization values forwarded to `@wasmer/sdk`. The first initialization wins. */
export interface WasmerInitializationOptions {
  /** Custom Wasmer SDK WebAssembly source. */
  readonly module?:
    | RequestInfo
    | URL
    | Response
    | BufferSource
    | WebAssembly.Module
    | Promise<RequestInfo | URL | Response | BufferSource | WebAssembly.Module>;
  /** URL of the worker module used by the Wasmer thread pool. */
  readonly workerUrl?: string | URL;
  /** URL from which Wasmer workers import the SDK module. */
  readonly sdkUrl?: string | URL;
  /** Wasmer Registry GraphQL endpoint. */
  readonly registryUrl?: string;
  /** Optional Wasmer Registry access token. */
  readonly token?: string;
  /** Optional Wasmer SDK log filter. */
  readonly log?: string;
}

/** Configuration for the Wasmer runtime shared by a shell process. */
export interface WasmerRuntimeOptions {
  /** Registry endpoint used when resolving package dependencies, or `null` to disable it. */
  readonly registry?: string | null;
  /** Optional registry API key. */
  readonly apiKey?: string;
  /** Optional gateway used for WASIX networking. */
  readonly networkGateway?: string;
}

/** A Wasmer package resolved by registry name. */
export interface WasmerRegistryPackageSource {
  /** Package-source discriminator. */
  readonly type: 'registry';
  /** Versioned Wasmer Registry specifier, such as `namespace/package@1.2.3`. */
  readonly specifier: string;
}

/** A self-hosted WebC package resolved by URL. */
export interface WasmerUrlPackageSource {
  /** Package-source discriminator. */
  readonly type: 'url';
  /** URL of the WebC package file. */
  readonly url: string | URL;
  /** Optional fetch implementation used to download the package. */
  readonly fetch?: typeof fetch;
}

/** A WebC package already loaded into memory. */
export interface WasmerBytesPackageSource {
  /** Package-source discriminator. */
  readonly type: 'bytes';
  /** Complete WebC package bytes. */
  readonly data: ArrayBuffer | Uint8Array;
}

/** A raw WASI or WASIX WebAssembly module loaded directly by Wasmer. */
export interface WasmerWasmPackageSource {
  /** Package-source discriminator. */
  readonly type: 'wasm';
  /** Complete WebAssembly module bytes. */
  readonly data: ArrayBuffer | Uint8Array;
}

/** Supported sources for a runnable Wasmer package. */
export type WasmerPackageSource =
  | WasmerRegistryPackageSource
  | WasmerUrlPackageSource
  | WasmerBytesPackageSource
  | WasmerWasmPackageSource;

/** Initial files for a WASIX virtual directory, keyed by path. */
export type WasmerDirectoryFiles = Readonly<Record<string, string | Uint8Array>>;

/** A directory entry returned by a Wasmer virtual filesystem. */
export interface WasmerDirectoryEntry {
  /** Entry type reported by Wasmer. */
  readonly type: 'file' | 'dir' | 'unknown';
  /** Final path component. */
  readonly name: string;
}

/** Public operations on a shared Wasmer virtual directory. */
export interface WasmerDirectory extends Disposable {
  /** Lists entries below a directory-relative path. */
  readDir(path: string): Promise<readonly WasmerDirectoryEntry[]>;
  /** Writes UTF-8 text or bytes to a directory-relative file. */
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  /** Reads a directory-relative file as bytes. */
  readFile(path: string): Promise<Uint8Array>;
  /** Reads a directory-relative file as UTF-8 text. */
  readTextFile(path: string): Promise<string>;
  /** Creates a directory-relative directory. */
  createDir(path: string): Promise<void>;
  /** Removes an empty directory-relative directory. */
  removeDir(path: string): Promise<void>;
  /** Removes a directory-relative file. */
  removeFile(path: string): Promise<void>;
}

/** Mount value accepted when starting a Wasmer shell. */
export type WasmerMount = WasmerDirectory | WasmerDirectoryFiles;

/** Final output and exit status returned by a Wasmer process. */
export interface WasmerProcessOutput {
  /** Process exit code. */
  readonly code: number;
  /** Whether the process exited successfully. */
  readonly ok: boolean;
  /** Complete captured stdout bytes. */
  readonly stdoutBytes: Uint8Array;
  /** Complete captured stdout decoded as UTF-8. */
  readonly stdout: string;
  /** Complete captured stderr bytes. */
  readonly stderrBytes: Uint8Array;
  /** Complete captured stderr decoded as UTF-8. */
  readonly stderr: string;
}

/** Structural subset of a running `@wasmer/sdk` instance used by the transport adapter. */
export interface WasmerProcessInstance {
  /** Writable process stdin, or `undefined` when stdin was supplied at spawn time. */
  readonly stdin?: WritableStream<Uint8Array>;
  /** Streaming process stdout. */
  readonly stdout: ReadableStream<WasmerStreamChunk>;
  /** Streaming process stderr. */
  readonly stderr: ReadableStream<WasmerStreamChunk>;
  /** Waits for the process to exit. */
  wait(): Promise<WasmerProcessOutput>;
}

/** Configuration used to start a browser-only Wasmer shell process. */
export interface CreateWasmerShellOptions {
  /** Registry, URL, or in-memory WebC package source. */
  readonly package: WasmerPackageSource;
  /** Named package command; the package entrypoint is used when omitted. */
  readonly command?: string;
  /** Additional command-line arguments. */
  readonly args?: readonly string[];
  /** Environment variables. `TERM` and `COLORTERM` receive terminal-friendly defaults. */
  readonly env?: Readonly<Record<string, string>>;
  /** Initial working directory inside the WASIX filesystem. */
  readonly cwd?: string;
  /** Virtual directories mounted by absolute guest path. */
  readonly mount?: Readonly<Record<string, WasmerMount>>;
  /** Additional registry packages exposed to the process. */
  readonly uses?: readonly string[];
  /** Options used for the process's Wasmer runtime. */
  readonly runtime?: WasmerRuntimeOptions;
  /** Options used during the process-wide Wasmer SDK initialization. */
  readonly initialization?: WasmerInitializationOptions;
}

/** Lifecycle states of a managed Wasmer shell session. */
export type WasmerShellStatus = 'running' | 'closing' | 'exited' | 'error' | 'disposed';

/** Features provided by a managed Wasmer shell session. */
export interface WasmerShellCapabilities {
  /** Whether the session has interactive stdin. */
  readonly interactiveInput: boolean;
  /** Whether virtual filesystem mounts are supported. */
  readonly filesystem: true;
  /** Whether WASIX package subprocesses are supported. */
  readonly subprocesses: true;
  /** Whether the SDK exposes a terminal window-size operation. Currently `false`. */
  readonly resize: false;
}

/** Managed byte streams and lifecycle for a running Wasmer shell. */
export interface WasmerShellSession extends Disposable {
  /** Terminal-compatible byte streams. They may be connected once. */
  readonly transport: TerminalTransport;
  /** Process capabilities that integrations may feature-detect. */
  readonly capabilities: WasmerShellCapabilities;
  /** Current lifecycle state. */
  readonly status: WasmerShellStatus;
  /** Failure that moved the session into the `error` state. */
  readonly error: Error | undefined;
  /** Resolves with captured output and status when the process exits. */
  readonly exit: Promise<WasmerProcessOutput>;
  /** Closes stdin and waits for the process to exit. */
  close(): Promise<WasmerProcessOutput>;
  /** Subscribes to lifecycle transitions. */
  onStatusChange(listener: (status: WasmerShellStatus) => void): Disposable;
}

/** Result produced after a {@link WasmerAddon} attaches a shell to a terminal. */
export interface WasmerAddonReady {
  /** Managed Wasmer process session. */
  readonly session: WasmerShellSession;
  /** Active native terminal transport connection. */
  readonly connection: TerminalConnection;
}

/** Configuration for a Wasmer-backed terminal addon. */
export interface WasmerAddonOptions extends CreateWasmerShellOptions {
  /** Backpressure and cancellation policy passed to the native terminal connection. */
  readonly connection?: TerminalConnectionOptions;
}

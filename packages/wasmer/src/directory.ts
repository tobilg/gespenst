import { loadWasmerSdk } from './sdk.js';
import type {
  WasmerDirectory,
  WasmerDirectoryEntry,
  WasmerDirectoryFiles,
  WasmerInitializationOptions,
} from './types.js';

interface DirectoryHandle {
  free(): void;
  readDir(path: string): Promise<WasmerDirectoryEntry[]>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  createDir(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

const handles = new WeakMap<WasmerDirectory, DirectoryHandle>();

class ManagedWasmerDirectory implements WasmerDirectory {
  private disposed = false;

  constructor(handle: DirectoryHandle) {
    handles.set(this, handle);
  }

  readDir(path: string): Promise<readonly WasmerDirectoryEntry[]> {
    return this.handle().readDir(path);
  }

  writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    return this.handle().writeFile(path, contents);
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.handle().readFile(path);
  }

  readTextFile(path: string): Promise<string> {
    return this.handle().readTextFile(path);
  }

  createDir(path: string): Promise<void> {
    return this.handle().createDir(path);
  }

  removeDir(path: string): Promise<void> {
    return this.handle().removeDir(path);
  }

  removeFile(path: string): Promise<void> {
    return this.handle().removeFile(path);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    handles.get(this)?.free();
    handles.delete(this);
  }

  private handle(): DirectoryHandle {
    if (this.disposed) throw new Error('WasmerDirectory is disposed');
    const handle = handles.get(this);
    if (!handle) throw new Error('WasmerDirectory handle is unavailable');
    return handle;
  }
}

/** Creates a shared virtual directory that can be mounted into one or more Wasmer processes. */
export async function createWasmerDirectory(
  files: WasmerDirectoryFiles = {},
  initialization: WasmerInitializationOptions = {}
): Promise<WasmerDirectory> {
  const sdk = await loadWasmerSdk(initialization);
  const initial = Object.fromEntries(Object.entries(files));
  return new ManagedWasmerDirectory(new sdk.Directory(initial) as DirectoryHandle);
}

/** @internal */
export function unwrapWasmerDirectory(directory: WasmerDirectory): DirectoryHandle {
  const handle = handles.get(directory);
  if (!handle) throw new Error('WasmerDirectory was not created by createWasmerDirectory()');
  return handle;
}

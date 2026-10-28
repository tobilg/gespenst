import type { IDisposable, IEvent } from '@xterm/xterm';

export class EventEmitter<T> implements IDisposable {
  private readonly listeners = new Set<(value: T) => unknown>();
  /** Listeners as of the last change; `fire` iterates it so listeners may (un)subscribe. */
  private snapshot: readonly ((value: T) => unknown)[] = [];

  readonly event: IEvent<T> = (listener) => {
    this.listeners.add(listener);
    this.snapshot = [...this.listeners];
    return {
      dispose: () => {
        if (this.listeners.delete(listener)) this.snapshot = [...this.listeners];
      },
    };
  };

  get hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  get size(): number {
    return this.listeners.size;
  }

  fire(value: T): void {
    for (const listener of this.snapshot) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
    this.snapshot = [];
  }
}

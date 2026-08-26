import type { IDisposable, IEvent } from '@xterm/xterm';

export class EventEmitter<T> implements IDisposable {
  private readonly listeners = new Set<(value: T) => unknown>();

  readonly event: IEvent<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

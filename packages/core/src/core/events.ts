import type { Disposable } from './types.js';

export class TypedEventEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(value: never) => void>>();

  on<Key extends keyof Events>(type: Key, listener: (value: Events[Key]) => void): Disposable {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (value: never) => void);
    return { dispose: () => listeners?.delete(listener as (value: never) => void) };
  }

  emit<Key extends keyof Events>(type: Key, value: Events[Key]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(value as never);
  }

  clear(): void {
    this.listeners.clear();
  }
}

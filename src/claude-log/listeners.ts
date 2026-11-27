/** A small event emitter for modules that must not import vscode. */

export interface Unsubscribe {
  dispose(): void;
}

export class Listeners<T> {
  private readonly listeners = new Set<(value: T) => void>();

  add(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Every listener runs even if one throws; the first error is rethrown afterwards. */
  emit(value: T): void {
    let firstError: unknown;
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}

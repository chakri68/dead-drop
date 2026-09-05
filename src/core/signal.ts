/** Minimal observable. The UI subscribes; transports write. */
export class Signal<T> {
  private value: T;
  private listeners = new Set<(v: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(v: T): void {
    if (Object.is(v, this.value)) return;
    this.value = v;
    for (const l of this.listeners) l(v);
  }

  subscribe(fn: (v: T) => void): () => void {
    this.listeners.add(fn);
    fn(this.value);
    return () => this.listeners.delete(fn);
  }
}

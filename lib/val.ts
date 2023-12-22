// Basically the behavior subject i.e. an observable value
// The "not equal" logic is using the same one from svelte
interface ReadonlyVal<T> {
  readonly value: T;
  subscribe(observer: (value: T) => void): () => void;
  dispose(): void;
}

const safe_not_equal = (a: unknown, b: unknown): unknown => a != a ? b == b : a !== b || (a && typeof a === 'object') || typeof a === 'function';

export const val = <T>(value: T, init: (set: (newValue: T) => void) => unknown): ReadonlyVal<T> => {
  const observers = new Set<(value: T) => void>();
  const stop = init(set);

  function set(newValue: T) {
    if (safe_not_equal(value, newValue)) {
      value = newValue;
      for (const observer of observers) {
        observer(value);
      }
    }
  }

  function subscribe(observer: (value: T) => void) {
    observers.add(observer);
    observer(value);
    return () => observers.delete(observer);
  }

  function dispose() {
    stop && typeof stop === 'function' && stop();
    observers.clear();
  }

  return {
    get value() { return value; },
    subscribe,
    dispose
  };
};

import "@testing-library/jest-dom/vitest";

// Node 22+ exposes an experimental global localStorage that is undefined
// unless --localstorage-file is set. Theme code uses the unqualified name.
if (typeof globalThis.localStorage === "undefined" || !globalThis.localStorage?.getItem) {
  const store = new Map();
  const memory = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(String(key)); },
    clear: () => { store.clear(); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  globalThis.localStorage = memory;
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memory });
  }
}

// Polyfill ResizeObserver for jsdom (needed by useAnimatedHeight hook)
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

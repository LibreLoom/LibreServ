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

// jsdom lacks matchMedia — codemirror-markdown-tables queries it when the
// cell editors mount. The app's useIsMdUp hook treats a *missing* matchMedia
// as desktop, so the stub must preserve that: min-width queries match,
// everything else (dark scheme, reduced motion) doesn't.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: /min-width/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom has no layout engine: Range lacks getClientRects/getBoundingClientRect,
// which CodeMirror's selection layer calls when measuring. Stub both.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  const emptyRectList = /** @type {DOMRectList} */ (
    Object.assign([], { item: () => null })
  );
  Range.prototype.getClientRects = () => emptyRectList;
  Range.prototype.getBoundingClientRect = () => /** @type {DOMRect} */ ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  });
}

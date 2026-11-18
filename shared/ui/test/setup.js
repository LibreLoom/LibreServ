import "@testing-library/jest-dom";
import { installAsyncDefaults } from "./waitFor.js";
import { installContrastCheck } from "./contrast.js";

// How long async assertions may wait (testing-library and vi.waitFor): see waitFor.js.
installAsyncDefaults();

// Fail any test that leaves text in the same color as the surface behind it.
installContrastCheck();

// Polyfill ResizeObserver for jsdom (needed by useAnimatedHeight hook)
globalThis.ResizeObserver = class ResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = new Set();
  }
  observe(target) {
    this.observed.add(target);
  }
  unobserve(target) {
    this.observed.delete(target);
  }
  disconnect() {
    this.observed.clear();
  }
};

// Node 26 exposes an experimental global localStorage that is undefined unless
// --localstorage-file is set, and it shadows jsdom's. Swap in a plain in-memory
// Storage when the global one doesn't work, so tests don't depend on the Node version.
// The methods live on Storage.prototype so tests can still spy on Storage.prototype.
if (typeof globalThis.localStorage?.clear !== "function") {
  const data = new WeakMap();
  const store = (self) => {
    if (!data.has(self)) data.set(self, new Map());
    return data.get(self);
  };
  Object.assign(Storage.prototype, {
    getItem(key) {
      return store(this).has(key) ? store(this).get(key) : null;
    },
    setItem(key, value) {
      store(this).set(key, String(value));
    },
    removeItem(key) {
      store(this).delete(key);
    },
    clear() {
      store(this).clear();
    },
    key(index) {
      return [...store(this).keys()][index] ?? null;
    },
  });
  Object.defineProperty(Storage.prototype, "length", {
    configurable: true,
    get() {
      return store(this).size;
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: Object.create(Storage.prototype),
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: Object.create(Storage.prototype),
    configurable: true,
  });
}

// Polyfill document.elementFromPoint for jsdom (needed by input-otp, which
// uses it to map pointer events to slot positions). jsdom doesn't implement it.
if (typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}

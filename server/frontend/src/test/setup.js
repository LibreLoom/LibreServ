import "@testing-library/jest-dom";

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

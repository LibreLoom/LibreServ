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

// Polyfill document.elementFromPoint for jsdom (needed by input-otp, which
// uses it to map pointer events to slot positions). jsdom doesn't implement it.
if (typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}

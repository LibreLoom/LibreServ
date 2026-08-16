import "@testing-library/jest-dom/vitest";

// Polyfill ResizeObserver for jsdom (needed by useAnimatedHeight hook)
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

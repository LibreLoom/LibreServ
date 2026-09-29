import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";
import { installContrastCheck } from "./contrast.js";

// CI containers are slow (cold npm install + import phase); give async
// assertions (waitFor/findBy) headroom beyond testing-library's 1s default so
// they don't flake under load. Assertions themselves are unchanged.
configure({ asyncUtilTimeout: 10000 });

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

// Polyfill document.elementFromPoint for jsdom (needed by input-otp, which
// uses it to map pointer events to slot positions). jsdom doesn't implement it.
if (typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}

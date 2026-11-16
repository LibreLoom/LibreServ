import { vi } from "vitest";
import { configure } from "@testing-library/react";

/**
 * One place for how long async assertions may wait, for every app's test setup.
 *
 * testing-library's waitFor/findBy and vitest's vi.waitFor each have their own
 * 1s default, and heavy pages (lazy chunks, jsdom layout) lag past it on a
 * loaded machine; that is what failed the release gate. Both return the moment
 * the condition holds, so a longer limit only bounds a real failure. A call
 * that passes its own timeout still wins.
 */
export const ASYNC_TIMEOUT_MS = 10_000;

export function installAsyncDefaults() {
  configure({ asyncUtilTimeout: ASYNC_TIMEOUT_MS });
  const waitFor = vi.waitFor.bind(vi);
  vi.waitFor = (fn, options) =>
    waitFor(
      fn,
      typeof options === "number"
        ? { timeout: options, interval: 10 }
        : { timeout: ASYNC_TIMEOUT_MS, interval: 10, ...options },
    );
}

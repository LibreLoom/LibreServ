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

/**
 * An app's test setup must pass its OWN `configure` and `vi`: an app with its
 * own node_modules loads its own copies of @testing-library/react and vitest,
 * and setting this module's copies leaves the app on the 1s default.
 * @param {{ configure?: typeof configure, vi?: typeof vi }} [libs]
 */
export function installAsyncDefaults({ configure: configureLib = configure, vi: viLib = vi } = {}) {
  configureLib({ asyncUtilTimeout: ASYNC_TIMEOUT_MS });
  const waitFor = viLib.waitFor.bind(viLib);
  viLib.waitFor = (fn, options) =>
    waitFor(
      fn,
      typeof options === "number"
        ? { timeout: options, interval: 10 }
        : { timeout: ASYNC_TIMEOUT_MS, interval: 10, ...options },
    );
}

import { lazy } from "react";

/**
 * React.lazy plus a `preload()` that fetches the code ahead of time.
 *
 * A plain lazy component suspends on its first render even when its code is
 * already downloaded (import() always answers on a later tick). The page then
 * mounts behind a fallback, and React holds the real content back until 300 ms
 * after that fallback appeared: every first visit to a preloaded page waited
 * ~300 ms for nothing (W16). Once `preload()` has finished, this one renders
 * straight away.
 *
 * @template {import("react").ComponentType<any>} T
 * @param {() => Promise<{ default: T }>} loader
 * @returns {import("react").LazyExoticComponent<T> & { preload: () => Promise<{ default: T }> }}
 */
export default function lazyWithPreload(loader) {
  /** @type {{ default: T } | null} */
  let loaded = null;
  /** @type {Promise<{ default: T }> | null} */
  let pending = null;
  const preload = () => {
    pending ||= loader().then(
      (mod) => {
        loaded = mod;
        return mod;
      },
      (err) => {
        // Let a later preload or render try again (a flaky connection).
        pending = null;
        throw err;
      },
    );
    return pending;
  };
  // React reads a thenable that settles synchronously as already loaded.
  const Component = /** @type {import("react").LazyExoticComponent<T>} */ (
    lazy(() => (loaded ? /** @type {any} */ ({ then: (resolve) => resolve(loaded) }) : preload()))
  );
  return Object.assign(Component, { preload });
}

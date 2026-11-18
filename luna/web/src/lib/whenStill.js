/**
 * Run `fn` once the browser is idle and the page has been still (no scroll)
 * for `quietMs`, counting from the call. For warm-ups that load a large
 * module: evaluating one is a single long task, and an idle callback's
 * timeout can fire in the middle of a scroll, where that task froze the list
 * for 100+ ms (W6 over a slow link). People often scroll a folder as soon as
 * it shows, so the first quiet period starts at the call, and scrolling
 * pushes the work back until the page is still again.
 * @param {() => void} fn
 * @param {{ quietMs?: number, timeout?: number }} [options]
 * @returns {() => void} cancels the pending call
 */
export function whenIdleAndStill(fn, { quietMs = 1000, timeout = 3000 } = {}) {
  let lastScroll = performance.now();
  let idleHandle = 0;
  let timer = 0;
  let stopped = false;
  const onScroll = () => {
    lastScroll = performance.now();
  };
  const idle = window.requestIdleCallback
    ? (/** @type {() => void} */ cb) => window.requestIdleCallback(cb, { timeout })
    : (/** @type {() => void} */ cb) => window.setTimeout(cb, 1500);
  const cancelIdle = window.cancelIdleCallback || window.clearTimeout;
  const stop = () => {
    stopped = true;
    window.removeEventListener("scroll", onScroll, true);
    if (idleHandle) cancelIdle(idleHandle);
    if (timer) window.clearTimeout(timer);
    idleHandle = 0;
    timer = 0;
  };
  const attempt = () => {
    idleHandle = 0;
    if (stopped) return;
    const wait = lastScroll + quietMs - performance.now();
    if (wait > 0) {
      timer = window.setTimeout(() => {
        timer = 0;
        if (!stopped) idleHandle = idle(attempt);
      }, wait);
      return;
    }
    stop();
    fn();
  };
  // Capture: a scroll inside any scroller counts, not only the window's.
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  idleHandle = idle(attempt);
  return stop;
}

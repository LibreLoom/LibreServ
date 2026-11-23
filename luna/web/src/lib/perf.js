// Journey timing for the performance harness (luna/perf/budgets.json).
//
// Each timing point carries its journey ID (`W4`, `W9:full`, …) so a number
// maps straight back to a budget. Under the hood it is only
// performance.mark/measure — the measures show up in the browser's
// Performance panel — plus a small list on `window.__lunaPerf` that the
// Playwright journey spec (web/perf/journeys.spec.js) reads. No UI, nothing
// sent anywhere.
//
// Every call does nothing until initPerf() has run (main.jsx does that; unit
// tests never do), and stays safe where the Performance API is missing or
// partial: it does nothing instead of throwing.
//
// Timing that would cost real users something (W8: a check after every
// scroll on Photos) only runs in "detailed" mode: the perf spec turns it on,
// and in devtools `sessionStorage.setItem("luna.perf", "1")` then a reload.

const PREFIX = "luna:";
/** Upper bound for each list, so a long-lived tab never grows without limit. */
const MAX_ENTRIES = 500;
/** A start that follows a click or key press this soon is dated from the input. */
const INPUT_WINDOW_MS = 1000;
/** `keep: true` honours an earlier pending start only when it is this fresh (or sticky). */
const KEEP_WINDOW_MS = 2000;
/** Give up waiting for images after this long. */
const IMAGE_WATCH_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ id: string, start: number, duration: number }} PerfMeasure
 * @typedef {{ start: number, duration: number }} PerfLongTask
 * @typedef {{ start: number, size: number, element: string }} PerfLcp
 * @typedef {{
 *   measures: PerfMeasure[],
 *   longTasks: PerfLongTask[],
 *   lcp: PerfLcp | null,
 *   start: (id: string) => void,
 *   end: typeof perfEnd,
 *   cancel: typeof perfCancel,
 *   watchImages: typeof perfWhenImagesShown,
 *   clear: () => void,
 * }} LunaPerfStore
 */

/** @type {Map<string, number>} pending journey id → start time (ms since time origin) */
const pending = new Map();
/** @type {Set<string>} pending starts set from outside (the spec): `keep` always honours them */
const sticky = new Set();
/** @type {Set<string>} ids recorded once per document (perfSinceNavigation) */
const onceDone = new Set();
let lastInputAt = Number.NEGATIVE_INFINITY;
let initialised = false;
let detailed = false;

/** @type {LunaPerfStore} */
const store = {
  measures: [],
  longTasks: [],
  lcp: null,
  start: (id) => perfStart(id, { sticky: true }),
  end: perfEnd,
  cancel: perfCancel,
  watchImages: perfWhenImagesShown,
  clear() {
    store.measures.length = 0;
    store.longTasks.length = 0;
  },
};

function canMark() {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * @template T
 * @param {T[]} list
 * @param {T} entry
 */
function push(list, entry) {
  list.push(entry);
  if (list.length > MAX_ENTRIES) list.shift();
}

/** @param {() => void} fn runs after the next frame has painted */
function afterPaint(fn) {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(fn, 0);
    return;
  }
  // rAF runs just before the frame paints; a task queued from it runs after.
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/**
 * Record a measure from `start` to now under `name`.
 * @param {string} name
 * @param {number} start
 */
function record(name, start) {
  const end = now();
  /** @type {PerfMeasure} */
  const entry = { id: name, start, duration: Math.max(0, end - start) };
  push(store.measures, entry);
  if (!canMark() || typeof performance.measure !== "function") return entry;
  try {
    performance.measure(`${PREFIX}${name}`, { start, end });
  } catch {
    // Older engines without the options form: the list above still has it.
  }
  return entry;
}

/**
 * Start timing a journey. Starting again replaces the earlier start.
 * @param {string} id journey ID from budgets.json, e.g. "W4" or "W9:full"
 * @param {{ fromInput?: boolean, keep?: boolean, sticky?: boolean }} [options]
 *   fromInput: date the start from the click or key press that just happened
 *   (effects run a frame or more after it). keep: leave a fresh pending start
 *   alone — the spec or a click handler already marked the real start.
 *   sticky: `keep` honours this start however long ago it was (the spec's).
 */
export function perfStart(id, { fromInput = false, keep = false, sticky: isSticky = false } = {}) {
  if (!initialised) return;
  const t = now();
  const existing = pending.get(id);
  if (keep && existing !== undefined && (sticky.has(id) || t - existing < KEEP_WINDOW_MS)) return;
  const start = fromInput && t - lastInputAt < INPUT_WINDOW_MS ? lastInputAt : t;
  pending.set(id, start);
  if (isSticky) sticky.add(id);
  else sticky.delete(id);
  if (!canMark()) return;
  try {
    performance.mark(`${PREFIX}${id}:start`, { startTime: start });
  } catch {
    // Marks are a devtools nicety; the pending start above is what counts.
  }
}

/** @param {string} id */
export function perfPending(id) {
  return pending.has(id);
}

/** @param {string} id forget a pending start (the journey failed or was abandoned) */
export function perfCancel(id) {
  pending.delete(id);
  sticky.delete(id);
}

/**
 * End a pending journey now. Does nothing when no start is pending, so it is
 * safe to call from every render or event.
 * @param {string} id
 * @returns {PerfMeasure | null}
 */
export function perfEnd(id) {
  const start = pending.get(id);
  if (start === undefined) return null;
  perfCancel(id);
  return record(id, start);
}

/**
 * End a pending journey once the frame now being prepared has painted. A
 * newer start in the meantime wins: the stale end is dropped.
 * @param {string} id
 */
export function perfEndAfterPaint(id) {
  const start = pending.get(id);
  if (start === undefined) return;
  afterPaint(() => {
    if (pending.get(id) === start) perfEnd(id);
  });
}

/**
 * Record a journey that runs from the page load (time origin) to now, once
 * per document — the first load of a page, a guest opening a link.
 * @param {string} id
 * @param {{ path?: RegExp }} [options] only when the document was loaded at a path matching this
 */
export function perfSinceNavigation(id, { path } = {}) {
  if (!initialised || onceDone.has(id)) return;
  if (path && !path.test(navigationPath())) return;
  onceDone.add(id);
  afterPaint(() => record(id, 0));
}

/** Path the current document was loaded at (before any in-app navigation). */
function navigationPath() {
  try {
    const nav = /** @type {PerformanceNavigationTiming | undefined} */ (
      performance.getEntriesByType?.("navigation")?.[0]
    );
    return nav?.name ? new URL(nav.name).pathname : "";
  } catch {
    return "";
  }
}

/**
 * The Dashboard is usable. Ends W3 when a sign-in is pending; otherwise, on
 * the document's first Dashboard, records W1 (the spec labels a reload W2).
 */
export function perfAppReady() {
  if (!initialised) return;
  if (pending.has("W3")) {
    // A Dashboard reached by signing in is not a page load.
    onceDone.add("W1");
    perfEndAfterPaint("W3");
    return;
  }
  perfSinceNavigation("W1", { path: /^\/$/ });
}

/** Detailed mode: timing points with a cost to real users (see the top of this file). */
export function perfDetailed() {
  return detailed;
}

/**
 * @param {Element} el
 * @param {number} vw
 * @param {number} vh
 */
function inViewport(el, vw, vh) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
}

/**
 * End a pending journey once every image matching `selector` that sits in
 * the viewport has finished loading (or failed). Event driven: it checks
 * after each image load, so it costs nothing between loads, and it gives up
 * after 30 s.
 * @param {string} id
 * @param {string} selector
 */
export function perfWhenImagesShown(id, selector) {
  const start = pending.get(id);
  if (start === undefined || typeof document === "undefined") return;
  let scheduled = false;
  let done = false;
  const stop = () => {
    done = true;
    document.removeEventListener("load", onLoad, true);
    document.removeEventListener("error", onLoad, true);
    clearTimeout(timer);
  };
  const check = () => {
    scheduled = false;
    if (done) return;
    if (pending.get(id) !== start) {
      stop();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const shown = [...document.querySelectorAll(selector)].filter((el) => inViewport(el, vw, vh));
    if (shown.length === 0) return;
    // An image marked `data-thumb-pending` hasn't been asked for yet (an
    // image with no src counts as complete).
    const ready = (/** @type {Element} */ el) =>
      !(el instanceof HTMLImageElement) || (el.complete && !el.hasAttribute("data-thumb-pending"));
    if (shown.every(ready)) {
      stop();
      perfEndAfterPaint(id);
    }
  };
  const onLoad = (/** @type {Event} */ event) => {
    if (scheduled || !(event.target instanceof HTMLImageElement)) return;
    scheduled = true;
    afterPaint(check);
  };
  const timer = setTimeout(() => {
    stop();
    if (pending.get(id) === start) perfCancel(id);
  }, IMAGE_WATCH_TIMEOUT_MS);
  document.addEventListener("load", onLoad, true);
  document.addEventListener("error", onLoad, true);
  scheduled = true;
  afterPaint(check);
}

/**
 * @param {string} type
 * @param {(entries: PerformanceEntry[]) => void} handle
 */
function observe(type, handle) {
  if (typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
  try {
    new PerformanceObserver((list) => handle(list.getEntries())).observe({ type, buffered: true });
  } catch {
    // Unsupported options in this engine; skip the observer.
  }
}

/** @param {Element | null | undefined} el */
function describe(el) {
  if (!el) return "";
  const slot = el.closest?.("[data-slot]")?.getAttribute("data-slot");
  return `${el.tagName.toLowerCase()}${slot ? ` in ${slot}` : ""}`;
}

/**
 * Expose `window.__lunaPerf`, start the long-task and largest-paint
 * observers, and remember the latest click or key press. Call once, before
 * the app renders.
 */
export function initPerf() {
  if (initialised || typeof window === "undefined") return;
  initialised = true;
  /** @type {any} */ (window).__lunaPerf = store;
  try {
    detailed = Boolean(/** @type {any} */ (window).__lunaPerfDetailed) || window.sessionStorage.getItem("luna.perf") === "1";
  } catch {
    detailed = Boolean(/** @type {any} */ (window).__lunaPerfDetailed);
  }

  const noteInput = () => {
    lastInputAt = now();
  };
  // The click, not the press: a person can hold a mouse button (or rest a
  // finger) far longer than the app takes to react, and that time is not the
  // app's latency. W4/W16 date from the activation, as their budgets say.
  window.addEventListener("pointerup", noteInput, { capture: true, passive: true });
  window.addEventListener("keydown", noteInput, { capture: true, passive: true });

  observe("longtask", (entries) => {
    for (const e of entries) push(store.longTasks, { start: e.startTime, duration: e.duration });
  });
  observe("largest-contentful-paint", (entries) => {
    const last = /** @type {any} */ (entries[entries.length - 1]);
    if (!last) return;
    store.lcp = { start: last.renderTime || last.startTime, size: last.size || 0, element: describe(last.element) };
  });
}

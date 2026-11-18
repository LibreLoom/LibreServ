// Photo grids ask for a thumbnail in two tiers. The browser's own
// `loading="lazy"` starts every image within a few screens at once, so a
// jump through the timeline queued two or three screens of thumbnails and the
// ones in view waited behind them: over a remote link ~40 thumbnails
// (~0.9 MB) where ~12 were visible (W7/W8 in luna/perf).
//
// - Near: cells on screen start at once. Cells already
//   there when they mount start in the same frame, from one batched read of
//   their positions; the rest start from an IntersectionObserver callback.
//   Neither waits for a React render.
// - Ahead: cells within a few screens start only while no near thumbnail is
//   loading, a few at a time and nearest first. A short scroll still finds
//   them ready, and a jump never waits behind them for more than a few.
//   A grid that skips layout off screen (`content-visibility: auto`, marked
//   `data-thumb-group`) is watched as a whole: the browser reports cells
//   inside a skipped grid as off screen however close they are.
//   On a fast link (recent thumbnails mostly loaded in under FAST_LOAD_MS)
//   bytes are cheap, so every cell within FAST_AHEAD_SCREENS starts at once,
//   as the browser's lazy loading did; a jump on a LAN then lands on
//   thumbnails already fetched.

/**
 * How far beyond the screen's top and bottom a cell starts at once. None: on
 * a slow link the row past the edge took a third of the bandwidth from the
 * cells on screen after a jump (W8); it loads next, as an ahead load.
 */
export const NEAR_MARGIN_PX = 0;
/** How far ahead cells load while nothing near is loading (a share of the screen height). */
export const AHEAD_MARGIN = "300%";
/** Ahead thumbnails in flight at once. */
export const AHEAD_PARALLEL = 4;

/** A thumbnail that loads faster than this (ms, request to load event) means a fast link. */
export const FAST_LOAD_MS = 80;
/** How far ahead (in screen heights) cells start at once on a fast link. */
export const FAST_AHEAD_SCREENS = 8;
/** Recent load times, newest last. */
const recentLoads = /** @type {number[]} */ ([]);

/** True once most of the last few thumbnails came in fast (one late load event on a busy page doesn't count). */
function fastLink() {
  return recentLoads.length >= 3 && recentLoads.filter((ms) => ms < FAST_LOAD_MS).length >= recentLoads.length - 1;
}

/** @type {IntersectionObserver | null} */
let nearObserver = null;
/** @type {IntersectionObserver | null} */
let aheadObserver = null;
/** @type {Map<Element, () => void>} */
const waiting = new Map();
/** Waiting cells inside the ahead margin. */
const ahead = new Set();
/** What the ahead observer watches for each waiting cell: its group, or itself. */
const groupOf = new Map();
/** @type {Map<Element, Set<Element>>} waiting cells by group */
const members = new Map();
/** Groups inside the ahead margin. */
const groupsIn = new Set();

function join(/** @type {Element} */ el) {
  const group = el.parentElement?.closest("[data-thumb-group]") || el;
  groupOf.set(el, group);
  let set = members.get(group);
  if (!set) {
    set = new Set();
    members.set(group, set);
    aheadObserver?.observe(group);
  }
  set.add(el);
  if (groupsIn.has(group)) ahead.add(el);
}

function leave(/** @type {Element} */ el) {
  ahead.delete(el);
  const group = groupOf.get(el);
  groupOf.delete(el);
  const set = group && members.get(group);
  if (!set) return;
  set.delete(el);
  if (set.size === 0) {
    members.delete(group);
    groupsIn.delete(group);
    aheadObserver?.unobserve(group);
  }
}
/** Started near thumbnails that haven't loaded yet. */
const nearLoading = new Set();
/** Started ahead thumbnails that haven't loaded yet. */
const aheadLoading = new Set();
/** @type {Element[]} */
let fresh = [];
let checkQueued = false;
let pumpQueued = false;

function settled(/** @type {Element} */ el) {
  return !el.isConnected || (el instanceof HTMLImageElement && el.complete);
}

function track(/** @type {Element} */ el, /** @type {Set<Element>} */ set) {
  set.add(el);
  const t0 = performance.now();
  const done = () => {
    set.delete(el);
    recentLoads.push(performance.now() - t0);
    if (recentLoads.length > 4) recentLoads.shift();
    el.removeEventListener("load", done);
    el.removeEventListener("error", done);
    queuePump();
    if (set === nearLoading) wakeNearIdle();
  };
  el.addEventListener("load", done);
  el.addEventListener("error", done);
}

function start(/** @type {Element} */ el, /** @type {Set<Element>} */ set) {
  const done = waiting.get(el);
  if (!done) return;
  waiting.delete(el);
  leave(el);
  nearObserver?.unobserve(el);
  track(el, set);
  done();
}

/** Start ahead cells while nothing near is loading. */
function pump() {
  pumpQueued = false;
  // A thumbnail whose cell left the page never fires load; don't wait on it.
  for (const set of [nearLoading, aheadLoading]) for (const el of set) if (settled(el)) set.delete(el);
  const fast = fastLink();
  const pool = fast ? waiting.keys() : ahead;
  if ((fast ? waiting.size : ahead.size) === 0) return;
  if (nearLoading.size > 0 && !fast) return;
  const free = fast ? Infinity : AHEAD_PARALLEL - aheadLoading.size;
  if (free <= 0) return;
  const vh = window.innerHeight;
  const reach = fast ? FAST_AHEAD_SCREENS * vh : Infinity;
  // One layout read per day group, not one per photo in it.
  /** @type {Map<Element, number>} */
  const measured = new Map();
  const distance = (/** @type {Element} */ el) => {
    const box = groupOf.get(el) || el;
    let d = measured.get(box);
    if (d === undefined) {
      const r = box.getBoundingClientRect();
      d = r.bottom < 0 ? -r.bottom : Math.max(0, r.top - vh);
      measured.set(box, d);
    }
    return d;
  };
  [...pool]
    .filter((el) => el.isConnected)
    .map((el) => /** @type {[Element, number]} */ ([el, distance(el)]))
    .filter(([, d]) => d <= reach)
    .sort((a, b) => a[1] - b[1])
    .slice(0, free)
    .forEach(([el]) => start(el, aheadLoading));
}

function queuePump() {
  if (pumpQueued) return;
  pumpQueued = true;
  queueMicrotask(pump);
}

function observers() {
  if (nearObserver && aheadObserver) return;
  nearObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (entry.isIntersecting) start(entry.target, nearLoading);
    },
    { rootMargin: `${NEAR_MARGIN_PX}px 0px` },
  );
  aheadObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const set = members.get(entry.target);
        if (!set) continue;
        if (entry.isIntersecting) groupsIn.add(entry.target);
        else groupsIn.delete(entry.target);
        for (const el of set) {
          if (entry.isIntersecting) ahead.add(el);
          else ahead.delete(el);
        }
      }
      queuePump();
    },
    { rootMargin: `${AHEAD_MARGIN} 0px` },
  );
}

/**
 * One layout read for every cell mounted in this commit. A cell's group is
 * read first, and a cell in a group off screen is not read at all: asking
 * where a cell in a grid that skips layout (`content-visibility: auto`) is
 * lays that grid out on its own, one style and layout pass per day. On a
 * page appended below a jump that was ~45 ms at 4× CPU slowdown, before the
 * cells on screen could start (W8 in luna/perf).
 */
function checkFresh() {
  checkQueued = false;
  const list = fresh;
  fresh = [];
  const top = -NEAR_MARGIN_PX;
  const bottom = window.innerHeight + NEAR_MARGIN_PX;
  const onScreen = (/** @type {Element} */ el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > top && r.top < bottom;
  };
  /** @type {Map<Element, boolean>} */
  const groupOnScreen = new Map();
  const near = list.filter((el) => {
    if (!waiting.has(el) || !el.isConnected) return false;
    const group = groupOf.get(el);
    if (group && group !== el) {
      let shown = groupOnScreen.get(group);
      if (shown === undefined) {
        shown = onScreen(group);
        groupOnScreen.set(group, shown);
      }
      if (!shown) return false;
    }
    return onScreen(el);
  });
  near.forEach((el) => start(el, nearLoading));
}

/** False where there is no IntersectionObserver (old browsers, tests): load at once. */
export function canWatchNearViewport() {
  return typeof IntersectionObserver === "function";
}

/**
 * Call `onNear` once `el` (the thumbnail's img) should load: at once when it
 * is within NEAR_MARGIN_PX of the screen, or as an ahead load (see above).
 * At most once. Returns the function that stops watching.
 * @param {Element} el
 * @param {() => void} onNear
 */
export function whenNearViewport(el, onNear) {
  observers();
  waiting.set(el, onNear);
  nearObserver?.observe(el);
  join(el);
  fresh.push(el);
  if (fastLink()) queuePump();
  if (!checkQueued) {
    checkQueued = true;
    queueMicrotask(checkFresh);
  }
  return () => {
    if (!waiting.delete(el)) return;
    leave(el);
    nearObserver?.unobserve(el);
  };
}

/** @type {Set<() => void>} */
const nearIdleWaiters = new Set();

function wakeNearIdle() {
  if (nearIdleWaiters.size === 0) return;
  for (const el of nearLoading) if (settled(el)) nearLoading.delete(el);
  if (nearLoading.size > 0) return;
  const list = [...nearIdleWaiters];
  nearIdleWaiters.clear();
  list.forEach((cb) => cb());
}

/**
 * Call `cb` once no thumbnail on screen is loading: now, if none is (checked
 * after the cells mounted in this commit started theirs), or when the last
 * one loads. Work that can wait, like drawing photos below the screen, then
 * doesn't hold back the ones in view. Returns the function that cancels it.
 * @param {() => void} cb
 */
export function whenNearIdle(cb) {
  nearIdleWaiters.add(cb);
  queueMicrotask(wakeNearIdle);
  return () => {
    nearIdleWaiters.delete(cb);
  };
}

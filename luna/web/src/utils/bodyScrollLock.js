/**
 * Refcounted document scroll lock for full-screen overlays (PhotoLightbox, etc.).
 *
 * Uses `html[data-scroll-lock]` so callers that clear `document.body.style.overflow`
 * (ModalCard when its overlay stack empties) do not accidentally re-enable the
 * page scrollbar while another overlay still needs it locked.
 *
 * ModalCard's own dialog-scroller overflow rules are unrelated — this only
 * locks the underlying page / viewport.
 */

let lockCount = 0;

const ATTR = "data-scroll-lock";

function applyLock() {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(ATTR, "");
}

function clearLock() {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute(ATTR);
}

/**
 * Lock document scroll. Call the returned function to release this lock.
 * Nested locks are refcounted — scroll unlocks only when the last holder releases.
 * @returns {() => void}
 */
export function lockBodyScroll() {
  lockCount += 1;
  if (lockCount === 1) applyLock();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) clearLock();
  };
}

/** Test helper — reset module state between cases. */
export function __resetBodyScrollLockForTests() {
  lockCount = 0;
  clearLock();
}

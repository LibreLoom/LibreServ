const locks = new Set();
let previousOverflow = "";

const ATTRIBUTE = "data-scroll-lock";

/** Lock the viewport until the last open overlay releases its handle. */
export function lockBodyScroll() {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const lock = {};
  if (locks.size === 0) {
    previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    root.setAttribute(ATTRIBUTE, "");
  }
  locks.add(lock);
  return () => {
    if (!locks.delete(lock) || locks.size > 0) return;
    restoreScroll();
  };
}

function restoreScroll() {
  if (typeof document === "undefined") return;
  document.documentElement.style.overflow = previousOverflow;
  document.documentElement.removeAttribute(ATTRIBUTE);
}

export function __resetBodyScrollLockForTests() {
  if (locks.size > 0) restoreScroll();
  locks.clear();
}

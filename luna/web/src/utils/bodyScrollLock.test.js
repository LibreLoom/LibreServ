import { afterEach, describe, expect, it } from "vitest";
import {
  __resetBodyScrollLockForTests,
  lockBodyScroll,
} from "./bodyScrollLock.js";

afterEach(() => {
  __resetBodyScrollLockForTests();
});

describe("lockBodyScroll", () => {
  it("sets data-scroll-lock on html while held", () => {
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
    const unlock = lockBodyScroll();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);
    unlock();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
  });

  it("refcounts nested locks so ModalCard-style early release does not unlock", () => {
    const unlockLightbox = lockBodyScroll();
    const unlockModal = lockBodyScroll();

    // Modal closes first (clears its own lock / body.style.overflow).
    unlockModal();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);

    unlockLightbox();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
  });

  it("ignores double-release of the same unlock handle", () => {
    const unlock = lockBodyScroll();
    unlock();
    unlock();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);

    const unlockAgain = lockBodyScroll();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);
    unlockAgain();
  });
});

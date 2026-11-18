import { afterEach, describe, expect, it, vi } from "vitest";

/** Stub IntersectionObserver; returns the callbacks by rootMargin. */
function stubObservers() {
  /** @type {Record<string, (entries: any[]) => void>} */
  const byMargin = {};
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb, opts) {
        byMargin[opts.rootMargin] = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return byMargin;
}

/** An attached img that reports itself still loading until `finish()`. */
function pendingImg() {
  const img = document.createElement("img");
  let complete = false;
  Object.defineProperty(img, "complete", { get: () => complete });
  img.getBoundingClientRect = () => /** @type {DOMRect} */ ({ top: 5000, bottom: 5200, width: 200 });
  document.body.appendChild(img);
  return {
    img,
    finish() {
      complete = true;
      img.dispatchEvent(new Event("load"));
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
});

describe("whenNearViewport", () => {
  it("starts a near cell at once and holds ahead cells until it has loaded", async () => {
    const io = stubObservers();
    const mod = await import("./nearViewport.js");
    const near = pendingImg();
    const far = pendingImg();
    const onNear = vi.fn();
    const onFar = vi.fn();
    mod.whenNearViewport(near.img, onNear);
    mod.whenNearViewport(far.img, onFar);
    await flush();

    io[`${mod.NEAR_MARGIN_PX}px 0px`]([{ target: near.img, isIntersecting: true }]);
    io[`${mod.AHEAD_MARGIN} 0px`]([{ target: far.img, isIntersecting: true }]);
    await flush();
    expect(onNear).toHaveBeenCalledTimes(1);
    expect(onFar).not.toHaveBeenCalled();

    near.finish();
    await flush();
    expect(onFar).toHaveBeenCalledTimes(1);
  });

  it("on a fast link, starts ahead cells while near ones still load", async () => {
    const io = stubObservers();
    const mod = await import("./nearViewport.js");
    const near = mod.NEAR_MARGIN_PX + "px 0px";
    // Three thumbnails that load at once mark the link as fast.
    for (let i = 0; i < 3; i += 1) {
      const cell = pendingImg();
      mod.whenNearViewport(cell.img, () => {});
      await flush();
      io[near]([{ target: cell.img, isIntersecting: true }]);
      cell.finish();
    }
    const busy = pendingImg();
    mod.whenNearViewport(busy.img, () => {});
    const far = pendingImg();
    const onFar = vi.fn();
    mod.whenNearViewport(far.img, onFar);
    await flush();
    io[near]([{ target: busy.img, isIntersecting: true }]);
    io[`${mod.AHEAD_MARGIN} 0px`]([{ target: far.img, isIntersecting: true }]);
    await flush();
    expect(onFar).toHaveBeenCalledTimes(1);
  });

  it("forgets a cell that stopped watching", async () => {
    const io = stubObservers();
    const mod = await import("./nearViewport.js");
    const cell = pendingImg();
    const onNear = vi.fn();
    const stop = mod.whenNearViewport(cell.img, onNear);
    await flush();
    stop();
    io[`${mod.AHEAD_MARGIN} 0px`]([{ target: cell.img, isIntersecting: true }]);
    io[`${mod.NEAR_MARGIN_PX}px 0px`]([{ target: cell.img, isIntersecting: true }]);
    await flush();
    expect(onNear).not.toHaveBeenCalled();
  });
});

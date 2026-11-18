import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whenIdleAndStill } from "./whenStill.js";

describe("whenIdleAndStill", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    // Idle at once: the timing under test is the quiet period.
    vi.stubGlobal("requestIdleCallback", (cb) => setTimeout(cb, 0));
    vi.stubGlobal("cancelIdleCallback", (id) => clearTimeout(id));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits for the quiet period from the call", () => {
    const fn = vi.fn();
    whenIdleAndStill(fn, { quietMs: 1000 });
    vi.advanceTimersByTime(900);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("puts the call off while the page scrolls", () => {
    const fn = vi.fn();
    whenIdleAndStill(fn, { quietMs: 1000 });
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      window.dispatchEvent(new Event("scroll"));
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1100);
    expect(fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never calls once cancelled", () => {
    const fn = vi.fn();
    const cancel = whenIdleAndStill(fn, { quietMs: 1000 });
    vi.advanceTimersByTime(500);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

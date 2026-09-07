import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render, act, renderHook } from "@testing-library/react";
import { HEIGHT_SETTLE_MS, useAnimatedHeight } from "./useAnimatedHeight.jsx";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * @param {{ enabled?: boolean, innerHeight?: number, maxHeight?: string }} props
 */
function Probe({ enabled = true, innerHeight = 80, maxHeight }) {
  const { outerRef, innerRef, isAnimating, needsVerticalScroll } = useAnimatedHeight(enabled);
  const heightRef = useRef(innerHeight);
  heightRef.current = innerHeight;
  return (
    <div
      ref={outerRef}
      data-testid="outer"
      data-animating={isAnimating ? "1" : "0"}
      data-needs-scroll={needsVerticalScroll ? "1" : "0"}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div
        data-testid="inner"
        ref={(node) => {
          innerRef.current = node;
          if (node) {
            Object.defineProperty(node, "offsetHeight", {
              configurable: true,
              get: () => heightRef.current,
            });
          }
        }}
      />
    </div>
  );
}

describe("useAnimatedHeight", () => {
  it("returns outerRef, innerRef, isAnimating, and needsVerticalScroll", () => {
    const { result } = renderHook(() => useAnimatedHeight());
    expect(result.current).toHaveProperty("outerRef");
    expect(result.current).toHaveProperty("innerRef");
    expect(result.current).toHaveProperty("isAnimating");
    expect(result.current).toHaveProperty("needsVerticalScroll");
    expect(result.current.outerRef.current).toBeNull();
    expect(result.current.innerRef.current).toBeNull();
    expect(result.current.isAnimating).toBe(false);
    expect(result.current.needsVerticalScroll).toBe(false);
  });

  it("sets an explicit pixel height from the measured inner box", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        /** @param {ResizeObserverCallback} cb */
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
          this.cb([], this);
        }
        disconnect() {}
        unobserve() {}
      },
    );

    const { getByTestId } = render(<Probe innerHeight={96} />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(getByTestId("outer").style.height).toBe("96px");
    expect(getByTestId("outer").getAttribute("data-animating")).toBe("0");
    expect(getByTestId("outer").getAttribute("data-needs-scroll")).toBe("0");
  });

  it("updates outer height when ResizeObserver reports a new inner size", async () => {
    /** @type {ResizeObserverCallback[]} */
    const callbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        /** @param {ResizeObserverCallback} cb */
        constructor(cb) {
          callbacks.push(cb);
          this.cb = cb;
        }
        observe() {
          this.cb([], this);
        }
        disconnect() {}
        unobserve() {}
      },
    );

    const { getByTestId, rerender } = render(<Probe innerHeight={64} />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(getByTestId("outer").style.height).toBe("64px");

    rerender(<Probe innerHeight={240} />);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    expect(getByTestId("outer").style.height).toBe("240px");
    expect(getByTestId("outer").getAttribute("data-needs-scroll")).toBe("0");
  });

  it("flags isAnimating during px→px height changes until settle timeout", async () => {
    vi.useFakeTimers();
    /** @type {ResizeObserverCallback[]} */
    const callbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        /** @param {ResizeObserverCallback} cb */
        constructor(cb) {
          callbacks.push(cb);
          this.cb = cb;
        }
        observe() {
          this.cb([], this);
        }
        disconnect() {}
        unobserve() {}
      },
    );

    const { getByTestId, rerender } = render(<Probe innerHeight={64} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getByTestId("outer").getAttribute("data-animating")).toBe("0");

    rerender(<Probe innerHeight={240} />);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    expect(getByTestId("outer").style.height).toBe("240px");
    expect(getByTestId("outer").getAttribute("data-animating")).toBe("1");

    act(() => {
      vi.advanceTimersByTime(HEIGHT_SETTLE_MS);
    });
    expect(getByTestId("outer").getAttribute("data-animating")).toBe("0");
  });

  it("rebinds observation when enabled flips back to true", async () => {
    let observeCount = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        /** @param {ResizeObserverCallback} cb */
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
          observeCount += 1;
          this.cb([], this);
        }
        disconnect() {}
        unobserve() {}
      },
    );

    const { rerender, getByTestId } = render(<Probe enabled innerHeight={50} />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(observeCount).toBe(1);
    expect(getByTestId("outer").style.height).toBe("50px");

    rerender(<Probe enabled={false} innerHeight={50} />);
    expect(getByTestId("outer").style.height).toBe("");
    expect(getByTestId("outer").getAttribute("data-needs-scroll")).toBe("0");

    rerender(<Probe enabled innerHeight={50} />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(observeCount).toBe(2);
    expect(getByTestId("outer").style.height).toBe("50px");
  });

  it("clamps outer height to CSS max-height when content exceeds it", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        /** @param {ResizeObserverCallback} cb */
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
          this.cb([], this);
        }
        disconnect() {}
        unobserve() {}
      },
    );

    const { getByTestId } = render(<Probe innerHeight={500} maxHeight="300px" />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(getByTestId("outer").style.height).toBe("300px");
    expect(getByTestId("outer").getAttribute("data-needs-scroll")).toBe("1");
  });

  it("sets needsVerticalScroll only when content exceeds max-height", async () => {
    /** @type {ResizeObserverCallback[]} */
    const callbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        /** @param {ResizeObserverCallback} cb */
        constructor(cb) {
          callbacks.push(cb);
          this.cb = cb;
        }
        observe() {
          this.cb([], this);
        }
        disconnect() {}
        unobserve() {}
      },
    );

    const { getByTestId, rerender } = render(
      <Probe innerHeight={120} maxHeight="300px" />,
    );
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(getByTestId("outer").style.height).toBe("120px");
    expect(getByTestId("outer").getAttribute("data-needs-scroll")).toBe("0");

    rerender(<Probe innerHeight={450} maxHeight="300px" />);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    expect(getByTestId("outer").style.height).toBe("300px");
    expect(getByTestId("outer").getAttribute("data-needs-scroll")).toBe("1");

    rerender(<Probe innerHeight={180} maxHeight="300px" />);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    expect(getByTestId("outer").style.height).toBe("180px");
    expect(getByTestId("outer").getAttribute("data-needs-scroll")).toBe("0");
  });
});

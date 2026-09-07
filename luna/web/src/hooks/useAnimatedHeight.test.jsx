import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render, act, renderHook } from "@testing-library/react";
import { HEIGHT_SETTLE_MS, useAnimatedHeight } from "./useAnimatedHeight.jsx";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * @param {{ enabled?: boolean, innerHeight?: number }} props
 */
function Probe({ enabled = true, innerHeight = 80 }) {
  const { outerRef, innerRef, isAnimating } = useAnimatedHeight(enabled);
  const heightRef = useRef(innerHeight);
  heightRef.current = innerHeight;
  return (
    <div ref={outerRef} data-testid="outer" data-animating={isAnimating ? "1" : "0"}>
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
  it("returns outerRef and innerRef", () => {
    const { result } = renderHook(() => useAnimatedHeight());
    expect(result.current).toHaveProperty("outerRef");
    expect(result.current).toHaveProperty("innerRef");
    expect(result.current).toHaveProperty("isAnimating");
    expect(result.current.outerRef.current).toBeNull();
    expect(result.current.innerRef.current).toBeNull();
    expect(result.current.isAnimating).toBe(false);
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

    function MaxHeightProbe({ innerHeight = 500, maxHeight = "300px" }) {
      const { outerRef, innerRef } = useAnimatedHeight();
      const heightRef = useRef(innerHeight);
      heightRef.current = innerHeight;
      return (
        <div ref={outerRef} data-testid="outer" style={{ maxHeight }}>
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

    const { getByTestId } = render(<MaxHeightProbe innerHeight={500} maxHeight="300px" />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(getByTestId("outer").style.height).toBe("300px");
  });
});

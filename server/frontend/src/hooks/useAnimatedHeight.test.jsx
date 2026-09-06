import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef } from "react";
import { render, act, renderHook } from "@testing-library/react";
import { useAnimatedHeight } from "./useAnimatedHeight.jsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * @param {{ enabled?: boolean, innerHeight?: number }} props
 */
function Probe({ enabled = true, innerHeight = 80 }) {
  const { outerRef, innerRef } = useAnimatedHeight(enabled);
  const heightRef = useRef(innerHeight);
  heightRef.current = innerHeight;
  return (
    <div ref={outerRef} data-testid="outer">
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
    expect(result.current.outerRef.current).toBeNull();
    expect(result.current.innerRef.current).toBeNull();
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

  it("updates outer height when content size changes", async () => {
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

    const { getByTestId, rerender } = render(<Probe innerHeight={60} />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(getByTestId("outer").style.height).toBe("60px");

    rerender(<Probe innerHeight={240} />);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    expect(getByTestId("outer").style.height).toBe("240px");

    rerender(<Probe innerHeight={120} />);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    expect(getByTestId("outer").style.height).toBe("120px");
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


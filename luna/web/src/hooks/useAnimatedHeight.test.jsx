import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { useAnimatedHeight } from "./useAnimatedHeight.jsx";

function Probe({ marginTop = "0px" }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  return (
    <div ref={outerRef} data-testid="outer">
      <div ref={innerRef} data-testid="inner" style={{ height: 40, marginTop }}>
        content
      </div>
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

  describe("height measurement", () => {
    let OriginalRO;
    let lastCallback;

    beforeEach(() => {
      OriginalRO = globalThis.ResizeObserver;
      lastCallback = null;
      globalThis.ResizeObserver = class {
        constructor(cb) {
          lastCallback = cb;
        }
        observe() {
          if (lastCallback) lastCallback([]);
        }
        disconnect() {}
        unobserve() {}
      };
    });

    afterEach(() => {
      globalThis.ResizeObserver = OriginalRO;
    });

    it("sets outer height to inner offsetHeight when margins are zero", async () => {
      const { getByTestId } = render(<Probe />);
      const outer = getByTestId("outer");
      const inner = getByTestId("inner");
      Object.defineProperty(inner, "offsetHeight", { configurable: true, value: 40 });
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        marginTop: "0px",
        marginBottom: "0px",
      });
      lastCallback([]);
      await waitFor(() => {
        expect(outer.style.height).toBe("40px");
      });
    });

    it("adds vertical margins so clipped cards are not short", async () => {
      const { getByTestId } = render(<Probe marginTop="48px" />);
      const outer = getByTestId("outer");
      const inner = getByTestId("inner");
      Object.defineProperty(inner, "offsetHeight", { configurable: true, value: 40 });
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        marginTop: "48px",
        marginBottom: "0px",
      });
      lastCallback([]);
      await waitFor(() => {
        expect(outer.style.height).toBe("88px");
      });
    });
  });
});

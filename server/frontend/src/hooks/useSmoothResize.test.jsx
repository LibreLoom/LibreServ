import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useSmoothResize } from "../hooks/useSmoothResize";

function TestButton({ label }) {
  const ref = useRef(null);
  useSmoothResize(ref, { x: true });
  return (
    <button ref={ref} type="button" style={{ display: "inline-flex" }}>
      {label}
    </button>
  );
}

describe("useSmoothResize", () => {
  it("assigns a pixel width to a content-sized element", () => {
    const { container } = render(<TestButton label="User" />);
    const btn = container.querySelector("button");
    expect(btn.style.width).toMatch(/^\d+px$/);
  });

  it("does not pin width when the layout stretches the element (grid/flex)", () => {
    // jsdom has no layout engine (offsetWidth is always 0), so simulate the
    // rendered width being wider than the natural max-content width — the
    // signal for a grid/flex-stretched element. The hook must leave width
    // alone instead of pinning a px value that would collapse the button.
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        // While the hook is probing with width:max-content, report the
        // natural content width; otherwise report a wider stretched width.
        return this.style.width === "max-content" ? 60 : 200;
      },
    });
    try {
      const { container } = render(<TestButton label="Go Back" />);
      const btn = container.querySelector("button");
      expect(btn.style.width).toBe("");
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", desc);
    }
  });

  it("does not re-measure when the element's content is unchanged", () => {
    // A re-render for unrelated reasons (parent state churn, a reload) must
    // not re-probe the element: probing swaps width to max-content and back,
    // which cancels an in-flight width transition and snaps the element to
    // its target size instead of animating it. Count offsetWidth reads —
    // unchanged content must trigger none.
    let reads = 0;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        reads += 1;
        return this.style.width === "max-content" ? 60 : 40;
      },
    });
    try {
      const { rerender } = render(<TestButton label="User" />);
      const readsAfterMount = reads;
      rerender(<TestButton label="User" />);
      expect(reads).toBe(readsAfterMount);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", desc);
    }
  });

  it("re-measures when the element's content changes", () => {
    let reads = 0;
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        reads += 1;
        return this.style.width === "max-content" ? 60 : 40;
      },
    });
    try {
      const { rerender } = render(<TestButton label="User" />);
      const readsAfterMount = reads;
      rerender(<TestButton label="A much longer label" />);
      expect(reads).toBeGreaterThan(readsAfterMount);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", desc);
    }
  });
});
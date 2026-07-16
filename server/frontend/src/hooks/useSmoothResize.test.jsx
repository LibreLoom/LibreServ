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
});
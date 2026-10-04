import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useSlidingIndicator } from "./useSlidingIndicator.js";

function Row({ active, animate }) {
  const { trackRef, indicatorRef, registerItem } = useSlidingIndicator(active, { animate });
  return (
    <div ref={trackRef}>
      <span data-testid="puck" ref={indicatorRef} />
      {["a", "b"].map((k) => (
        <button key={k} type="button" ref={registerItem(k)}>{k}</button>
      ))}
    </div>
  );
}

describe("useSlidingIndicator", () => {
  it("shows the indicator only while an item is active", () => {
    const { rerender } = render(<Row active={null} />);
    const puck = screen.getByTestId("puck");
    expect(puck.style.opacity).toBe("0");
    rerender(<Row active="b" />);
    expect(puck.style.opacity).toBe("1");
    // jsdom has no layout, so position is 0 — but it is set from the item.
    expect(puck.style.transform).toBe("translateX(0px)");
    rerender(<Row active={null} />);
    expect(puck.style.opacity).toBe("0");
  });

  it("hands motion back to CSS after a jump", () => {
    const { rerender } = render(<Row active="a" animate={false} />);
    rerender(<Row active="b" animate={false} />);
    expect(screen.getByTestId("puck").style.transition).toBe("");
  });
});

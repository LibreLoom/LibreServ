// RollingNumber lives in shared/ui, whose own suite CI runs only two files of.
// The card is its heaviest user (counts, percentages and file sizes all roll),
// so its behaviour is pinned here, where the tests actually run.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import RollingNumber from "@libreloom/ui/components/common/RollingNumber.jsx";

/** The digit columns actually drawn: one per digit, each its own clip. */
const columns = (container) =>
  container.querySelectorAll("span[aria-hidden='true'].inline-block.overflow-hidden");

/** What a screen reader is told. */
const spoken = (container) => container.querySelector(".sr-only").textContent;

describe("RollingNumber", () => {
  it("draws one column per digit of a whole number", () => {
    const { container } = render(<RollingNumber value={482} />);
    expect(columns(container)).toHaveLength(3);
    expect(spoken(container)).toBe("482");
  });

  it("draws a fixed decimal part when asked", () => {
    // A file size: "96.0" is three columns and a point, and the point is text
    // between them, not a column.
    const { container } = render(<RollingNumber value={96} decimals={1} />);
    expect(columns(container)).toHaveLength(3);
    expect(spoken(container)).toBe("96.0");
    expect(container.textContent).toContain(".");
  });

  it("keeps the decimal's trailing zero", () => {
    // 96.04 → "96.0", not "96": the digit string is what gets drawn.
    const { container } = render(<RollingNumber value={96.04} decimals={1} />);
    expect(spoken(container)).toBe("96.0");
  });

  it("rounds to the decimals it was given", () => {
    const { container } = render(<RollingNumber value={96.06} decimals={1} />);
    expect(spoken(container)).toBe("96.1");
  });

  it("never draws a negative or a nonsense value", () => {
    expect(spoken(render(<RollingNumber value={-5} />).container)).toBe("0");
    expect(spoken(render(<RollingNumber value={Number.NaN} />).container)).toBe("0");
  });

  it("is a whole number by default, so a count never grows decimals", () => {
    const { container } = render(<RollingNumber value={7.9} />);
    expect(spoken(container)).toBe("8");
    expect(container.textContent).not.toContain(".");
  });
});

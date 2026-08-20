import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import Card from "./Card";
import HeaderCard from "./HeaderCard";

describe("Card", () => {
  it("puts layout className on the overflow clip and does not double-radius the fill", () => {
    const { container } = render(
      <Card className="mt-10 mb-4">body</Card>,
    );
    const clip = container.querySelector("[data-slot=card-clip]");
    const fill = container.querySelector("[data-slot=card]");
    expect(clip).toBeTruthy();
    expect(clip.className).toMatch(/mt-10/);
    expect(clip.className).toMatch(/mb-4/);
    expect(clip.className).toMatch(/overflow-hidden/);
    expect(clip.className).toMatch(/rounded-large-element/);
    expect(clip.className).toMatch(/pop-in/);
    expect(fill.className).not.toMatch(/rounded-large-element/);
    expect(fill.className).not.toMatch(/pop-in/);
    expect(fill.className).not.toMatch(/mt-10/);
  });
});

describe("HeaderCard", () => {
  it("stays a pill header after Card clip/radius split", () => {
    const { container } = render(<HeaderCard title="Drives" />);
    const clip = container.querySelector("[data-slot=card-clip]");
    expect(clip.className).toMatch(/rounded-pill/);
    expect(clip.className).not.toMatch(/rounded-large-element/);
  });
});

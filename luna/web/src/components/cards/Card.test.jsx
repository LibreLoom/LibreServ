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
  it("is a single pill surface so side chrome can v-center in the cap", () => {
    const { container } = render(<HeaderCard title="Drives" />);
    const fill = container.querySelector("[data-slot=card]");
    expect(container.querySelector("[data-slot=card-clip]")).toBeNull();
    expect(fill.className).toMatch(/rounded-pill/);
    expect(fill.className).not.toMatch(/rounded-large-element/);
  });

  it("vertically centers leftContent on the header row", () => {
    const { container } = render(
      <HeaderCard title="Nothing here" leftContent={<span data-testid="hdr-icon">i</span>} />,
    );
    const row = container.querySelector("[data-slot=card] > div");
    expect(row.className).toMatch(/items-center/);
    expect(row.className).toMatch(/py-1\.5/);
    expect(row.className).toMatch(/pl-1\.5/);
    expect(row.querySelector("[data-testid=hdr-icon]").parentElement.className).toMatch(/self-center/);
  });
});

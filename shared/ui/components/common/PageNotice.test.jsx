import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PageNotice from "./PageNotice";

describe("PageNotice", () => {
  it("renders children in a status container", () => {
    render(<PageNotice>Something went right</PageNotice>);
    expect(screen.getByRole("status")).toHaveTextContent("Something went right");
  });

  it("is its own opaque surface with the status tint layered on top", () => {
    const { container } = render(<PageNotice variant="error">Error message</PageNotice>);
    const clip = container.querySelector("[data-slot=card-clip]");
    expect(clip.className).toContain("surface-primary");
    expect(clip.className).toContain("from-error/20");
    expect(clip.className).toContain("border-error/50");
    // Text keeps the surface's color: no status-colored text, no bg override.
    expect(clip.className).not.toMatch(/\btext-error\b/);
    expect(clip.className).not.toMatch(/\bbg-error\//);
  });

  it("uses the requested surface for every variant", () => {
    for (const variant of ["error", "warning", "info"]) {
      const { container, unmount } = render(
        <PageNotice variant={variant} surface="secondary">On a card</PageNotice>,
      );
      expect(container.querySelector("[data-slot=card-clip]").className).toContain("surface-secondary");
      unmount();
    }
  });
});

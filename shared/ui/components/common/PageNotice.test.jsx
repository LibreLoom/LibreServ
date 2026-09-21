import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PageNotice from "./PageNotice";

describe("PageNotice", () => {
  it("renders children in a status container", () => {
    render(<PageNotice>Something went right</PageNotice>);
    expect(screen.getByRole("status")).toHaveTextContent("Something went right");
  });

  it("defaults to surface='primary' and uses text-secondary for warning variant for contrast on page bg", () => {
    const { container } = render(
      <PageNotice variant="warning">Warning message</PageNotice>
    );
    const cardClip = container.querySelector("[data-slot=card-clip]");
    expect(cardClip).toBeTruthy();
    expect(cardClip.className).toContain("text-secondary");
    expect(cardClip.className).not.toContain("text-primary");
    expect(cardClip.className).toContain("bg-warning/20");
    expect(cardClip.className).toContain("border-warning/30");
  });

  it("defaults to surface='primary' and uses text-secondary for info variant for contrast on page bg", () => {
    const { container } = render(
      <PageNotice variant="info">Info message</PageNotice>
    );
    const cardClip = container.querySelector("[data-slot=card-clip]");
    expect(cardClip).toBeTruthy();
    expect(cardClip.className).toContain("text-secondary");
    expect(cardClip.className).not.toContain("text-primary");
    expect(cardClip.className).toContain("bg-accent/10");
  });

  it("uses text-primary for warning and info variants when surface='secondary'", () => {
    const { container: warningContainer } = render(
      <PageNotice variant="warning" surface="secondary">
        Warning on card
      </PageNotice>
    );
    const warningClip = warningContainer.querySelector("[data-slot=card-clip]");
    expect(warningClip.className).toContain("text-primary");
    expect(warningClip.className).not.toContain("text-secondary");

    const { container: infoContainer } = render(
      <PageNotice variant="info" surface="secondary">
        Info on card
      </PageNotice>
    );
    const infoClip = infoContainer.querySelector("[data-slot=card-clip]");
    expect(infoClip.className).toContain("text-primary");
    expect(infoClip.className).not.toContain("text-secondary");
  });

  it("uses text-error for error variant regardless of surface", () => {
    const { container } = render(
      <PageNotice variant="error">Error message</PageNotice>
    );
    const cardClip = container.querySelector("[data-slot=card-clip]");
    expect(cardClip.className).toContain("text-error");
    expect(cardClip.className).toContain("bg-error/20");
  });
});

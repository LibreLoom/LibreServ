import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Unfold from "./Unfold.jsx";

describe("Unfold", () => {
  it("collapses sideways by default and makes closed content inert", () => {
    const { rerender, container } = render(
      <Unfold open={false}>
        <a href="#x">link</a>
      </Unfold>,
    );
    const root = container.querySelector('[data-slot="unfold"]');
    expect(root.className).toMatch(/grid-cols-\[0fr\]/);
    expect(screen.getByText("link").closest("[inert]")).not.toBeNull();

    rerender(
      <Unfold open>
        <a href="#x">link</a>
      </Unfold>,
    );
    expect(root.className).toMatch(/grid-cols-\[1fr\]/);
    expect(screen.getByText("link").closest("[inert]")).toBeNull();
  });

  it("unfolds downwards with axis y and uses the motion tokens", () => {
    const { container } = render(
      <Unfold open={false} axis="y">
        <p>body</p>
      </Unfold>,
    );
    const root = container.querySelector('[data-slot="unfold"]');
    expect(root.className).toMatch(/grid-rows-\[0fr\]/);
    expect(root.className).toMatch(/--motion-duration-medium1/);
    expect(root.className).toMatch(/--motion-easing-emphasized-decelerate/);
  });
});

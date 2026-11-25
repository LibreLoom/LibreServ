import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  findContrastProblems,
  findSurfaceMismatches,
} from "@libreloom/ui/test/contrast.js";
import { LunaUnreachableNotice } from "./App.jsx";

describe("LunaUnreachableNotice", () => {
  it("explains the outage and skips to the focusable main landmark", () => {
    const { container } = render(<LunaUnreachableNotice />);

    expect(screen.getByText("Luna")).toBeInTheDocument();
    expect(
      screen.getByText(/Can't reach Luna right now/),
    ).toBeInTheDocument();

    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#unreachable-content");
    // The link is outside <main>, and its target is the focusable <main>
    // landmark itself so keyboard and screen-reader focus really moves.
    const main = screen.getByRole("main");
    expect(main).not.toContainElement(skip);
    expect(container.querySelector("#unreachable-content")).toBe(main);
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("renders the notice with no surface or contrast mismatch", () => {
    const { container } = render(<LunaUnreachableNotice />);
    expect(findSurfaceMismatches(container)).toEqual([]);
    expect(findContrastProblems(container)).toEqual([]);
  });
});

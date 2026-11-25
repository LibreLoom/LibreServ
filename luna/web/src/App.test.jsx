import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  findContrastProblems,
  findSurfaceMismatches,
} from "@libreloom/ui/test/contrast.js";
import { LunaUnreachableNotice } from "./App.jsx";

describe("LunaUnreachableNotice", () => {
  it("explains the outage and skips to the notice, not the main landmark it sits in", () => {
    const { container } = render(<LunaUnreachableNotice />);

    expect(screen.getByText("Luna")).toBeInTheDocument();
    expect(
      screen.getByText(/Can't reach Luna right now/),
    ).toBeInTheDocument();

    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#unreachable-content");
    // The link is outside <main>, and its target is the inner notice content
    // rather than the <main> landmark the link used to point at.
    expect(screen.getByRole("main")).not.toContainElement(skip);
    const target = container.querySelector("#unreachable-content");
    expect(target).toBeInTheDocument();
    expect(target).not.toBe(screen.getByRole("main"));
  });

  it("renders the notice with no surface or contrast mismatch", () => {
    const { container } = render(<LunaUnreachableNotice />);
    expect(findSurfaceMismatches(container)).toEqual([]);
    expect(findContrastProblems(container)).toEqual([]);
  });
});

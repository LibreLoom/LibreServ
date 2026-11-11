import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import InlineError from "./InlineError";

describe("InlineError", () => {
  it("announces the message as an alert in the surface's text color", () => {
    const { container } = render(<InlineError>Word 3 isn't on the list.</InlineError>);
    expect(screen.getByRole("alert")).toHaveTextContent("Word 3 isn't on the list.");
    // The icon carries the tone; the text stays readable on whatever surface it lands on.
    expect(container.querySelector(".text-error")).toBeInTheDocument();
    expect(screen.getByRole("alert").className).toContain("text-primary");
  });

  it("takes an id so a field can describe itself with it", () => {
    render(<InlineError id="field-problem">Try again.</InlineError>);
    expect(screen.getByRole("alert")).toHaveAttribute("id", "field-problem");
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Button from "./Button.jsx";
import Spinner from "./Spinner.jsx";

describe("Spinner", () => {
  it("renders a 3×3 comet grid with status label", () => {
    const { container } = render(<Spinner label="Loading" />);
    const root = container.querySelector('[data-slot="spinner"]');
    expect(root).toBeTruthy();
    expect(root.className).toMatch(/comet-spinner/);
    expect(root.querySelectorAll(".comet-spinner__dot")).toHaveLength(8);
    expect(root.querySelectorAll(".comet-spinner__center")).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
  });

  it("can render as decorative without a status role", () => {
    const { container } = render(<Spinner decorative />);
    expect(container.querySelector('[data-slot="spinner"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Button loading", () => {
  it("shows the comet spinner and marks the control busy when loading", () => {
    render(
      <Button loading variant="secondary" surface="primary">
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: /Save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector('[data-slot="spinner"]')).toBeTruthy();
    expect(button.querySelectorAll(".comet-spinner__dot")).toHaveLength(8);
    expect(screen.getByText("Loading")).toHaveClass("sr-only");
  });

  it("does not show a spinner when idle", () => {
    render(<Button variant="secondary">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });
});

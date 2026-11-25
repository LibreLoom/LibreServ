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

  it("keeps its label in place while loading instead of growing", () => {
    const { rerender } = render(
      <Button loading variant="secondary" surface="primary">
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: /Save/i });
    const faded = button.querySelector(".opacity-0");
    // The label keeps its space; only its paint fades.
    expect(faded).toBeTruthy();
    expect(faded.textContent).toBe("Save");
    // The spinner sits over the label, not in the flow before it, so the
    // button cannot widen and shove its neighbours sideways.
    const spinner = button.querySelector('[data-slot="spinner"]');
    expect(spinner.parentElement.className).toMatch(/absolute/);
    expect(spinner.parentElement).not.toBe(faded);
    expect(spinner.parentElement).toHaveAttribute("aria-hidden", "false");

    // Done: the label comes back while the spinner fades out in place.
    rerender(
      <Button variant="secondary" surface="primary">
        Save
      </Button>,
    );
    expect(button.querySelector('[data-slot="spinner"]').parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(faded.className).not.toMatch(/opacity-0/);
  });

  it("does not show a spinner when idle", () => {
    render(<Button variant="secondary">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("icon buttons mount the spinner on first load, raise it, and park it below the clip after", () => {
    const { rerender } = render(
      <Button size="icon" variant="ghost" surface="secondary" aria-label="Save">
        <svg data-testid="save-icon" />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    // Idle and never loaded: no spinner layer at all (lists mount hundreds).
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
    // Loading: icon slides up out, spinner rises in from below the clip.
    rerender(
      <Button size="icon" variant="ghost" surface="secondary" loading aria-label="Save">
        <svg data-testid="save-icon" />
      </Button>,
    );
    const iconWrap = button.querySelector('[data-testid="save-icon"]').parentElement;
    const spinnerWrap = button.querySelector('[data-slot="spinner"]').parentElement;
    expect(iconWrap.className).toMatch(/-translate-y-full/);
    expect(spinnerWrap.className).toMatch(/translate-y-0/);
    expect(spinnerWrap.className).toMatch(/starting:translate-y-full/);
    expect(spinnerWrap).toHaveAttribute("aria-hidden", "false");
    // Done: the spinner stays mounted and slides back below the clip.
    rerender(
      <Button size="icon" variant="ghost" surface="secondary" aria-label="Save">
        <svg data-testid="save-icon" />
      </Button>,
    );
    expect(button.querySelector('[data-slot="spinner"]').parentElement).toBe(spinnerWrap);
    expect(spinnerWrap.className).toMatch(/(^|\s)translate-y-full/);
    expect(spinnerWrap).toHaveAttribute("aria-hidden", "true");
  });

  it("runs the spinner dots while loading and pauses them once done", () => {
    const { rerender } = render(
      <Button size="iconSm" variant="ghost" surface="secondary" loading aria-label="Save">
        <svg />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    // Preserve the span type for the inline animation style assertions below.
    const dots = () => /** @type {HTMLSpanElement[]} */ (
      Array.from(button.querySelectorAll("span.comet-spinner__dot"))
    );
    expect(dots()).toHaveLength(8);
    dots().forEach((d) => expect(d.style.animation).not.toBe("none"));
    const wrap = button.querySelector('[data-slot="spinner"]').parentElement;
    expect(wrap.className).toMatch(/will-change-transform/);
    rerender(
      <Button size="iconSm" variant="ghost" surface="secondary" aria-label="Save">
        <svg />
      </Button>,
    );
    dots().forEach((d) => expect(d.style.animation).toBe("none"));
    expect(wrap.className).not.toMatch(/will-change-transform/);
  });

  it("forwards ref and autoFocus to the underlying button element", () => {
    let buttonNode = null;
    render(
      <Button
        autoFocus
        ref={(node) => {
          buttonNode = node;
        }}
      >
        Action
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Action" });
    expect(buttonNode).toBe(button);
    expect(document.activeElement).toBe(button);
  });
});

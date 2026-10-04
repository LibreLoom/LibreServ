import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useHoverIntent } from "./useHoverIntent.js";
import { HOVER_INTENT } from "../lib/ui-tokens.js";

function Probe(props) {
  const returnRef = useRef(null);
  const { open, handlers } = useHoverIntent({ ...props, returnFocusRef: returnRef });
  return (
    <div>
      <button type="button" ref={returnRef}>back</button>
      <div data-testid="box" data-open={open || undefined} {...handlers}>
        <a href="#in">inside</a>
      </div>
    </div>
  );
}

describe("useHoverIntent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens after the token delay for a mouse and closes after the grace", async () => {
    render(<Probe />);
    const box = screen.getByTestId("box");
    fireEvent.pointerEnter(box, { pointerType: "mouse" });
    await act(async () => vi.advanceTimersByTime(HOVER_INTENT.openMs - 1));
    expect(box).not.toHaveAttribute("data-open");
    await act(async () => vi.advanceTimersByTime(1));
    expect(box).toHaveAttribute("data-open");

    fireEvent.pointerLeave(box, { pointerType: "mouse" });
    await act(async () => vi.advanceTimersByTime(HOVER_INTENT.closeMs));
    expect(box).not.toHaveAttribute("data-open");
  });

  it("takes per-use overrides", async () => {
    render(<Probe openMs={500} />);
    const box = screen.getByTestId("box");
    fireEvent.pointerEnter(box, { pointerType: "mouse" });
    await act(async () => vi.advanceTimersByTime(HOVER_INTENT.openMs));
    expect(box).not.toHaveAttribute("data-open");
    await act(async () => vi.advanceTimersByTime(500));
    expect(box).toHaveAttribute("data-open");
  });

  it("ignores touch hover", async () => {
    render(<Probe />);
    const box = screen.getByTestId("box");
    fireEvent.pointerEnter(box, { pointerType: "touch" });
    await act(async () => vi.advanceTimersByTime(1000));
    expect(box).not.toHaveAttribute("data-open");
  });

  it("opens for keyboard focus and closes on Escape, returning focus", async () => {
    render(<Probe />);
    const box = screen.getByTestId("box");
    const inside = screen.getByText("inside");
    await act(async () => {
      inside.focus();
      vi.runAllTimers();
    });
    expect(box).toHaveAttribute("data-open");
    fireEvent.keyDown(inside, { key: "Escape" });
    expect(box).not.toHaveAttribute("data-open");
    expect(screen.getByText("back")).toHaveFocus();
  });
});

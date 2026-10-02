import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import LinearProgress from "./LinearProgress.jsx";

describe("LinearProgress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is a labelled progress bar with two Material bars on a pill track", () => {
    const { container } = render(<LinearProgress label="Updating results" />);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole("progressbar", { name: "Updating results" })).toBeInTheDocument();
    expect(container.querySelector(".animate-md-bar-1")).not.toBeNull();
    expect(container.querySelector(".animate-md-bar-2")).not.toBeNull();
  });

  it("tints its track from the text colour of the surface it sits on", () => {
    const { rerender } = render(<LinearProgress />);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole("progressbar")).toHaveClass("bg-secondary/10");
    rerender(<LinearProgress surface="secondary" />);
    expect(screen.getByRole("progressbar")).toHaveClass("bg-primary/10");
  });

  it("waits before showing, so a fast answer never flashes it", () => {
    render(<LinearProgress delayMs={150} />);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60));
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-phase", "in");
  });

  it("never appears when it stops before the delay ends", () => {
    const { rerender } = render(<LinearProgress active delayMs={150} />);
    act(() => vi.advanceTimersByTime(50));
    rerender(<LinearProgress active={false} delayMs={150} />);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("eases out before it leaves the page", () => {
    const { rerender } = render(<LinearProgress active />);
    act(() => vi.advanceTimersByTime(0));
    rerender(<LinearProgress active={false} />);
    const bar = screen.getByRole("progressbar", { hidden: true });
    expect(bar).toHaveAttribute("data-phase", "out");
    expect(bar).toHaveClass("md-linear-exit");
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByRole("progressbar", { hidden: true })).not.toBeInTheDocument();
  });

  it("comes back if loading starts again mid-exit", () => {
    const { rerender } = render(<LinearProgress active />);
    act(() => vi.advanceTimersByTime(0));
    rerender(<LinearProgress active={false} />);
    act(() => vi.advanceTimersByTime(100));
    rerender(<LinearProgress active />);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-phase", "in");
  });
});

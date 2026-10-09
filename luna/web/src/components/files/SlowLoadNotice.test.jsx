import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SlowLoadNotice from "./SlowLoadNotice.jsx";

afterEach(() => vi.useRealTimers());

describe("SlowLoadNotice", () => {
  it("appears only after the delay and names the document type", () => {
    vi.useFakeTimers();
    render(<SlowLoadNotice name="Budget.xlsx" delayMs={1000} />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status").textContent).toContain("opening a spreadsheet for the first time");
  });

  it("falls back to 'file' for non-office names", () => {
    vi.useFakeTimers();
    render(<SlowLoadNotice name="a.drawio" delayMs={10} />);
    act(() => vi.advanceTimersByTime(10));
    expect(screen.getByRole("status").textContent).toContain("opening a file");
  });
});

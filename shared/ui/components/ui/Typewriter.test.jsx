import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import Typewriter, { useTypewriter, useTypewriterCycle } from "./Typewriter.jsx";

function reduceMotion(on) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: on && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  reduceMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTypewriter", () => {
  it("types one letter at a time", () => {
    const { result } = renderHook(() => useTypewriter("hello", { speed: 10 }));
    expect(result.current).toEqual({ shown: "", typing: true });
    act(() => vi.advanceTimersByTime(20));
    expect(result.current.shown).toBe("he");
    act(() => vi.advanceTimersByTime(30));
    expect(result.current).toEqual({ shown: "hello", typing: false });
  });

  it("keeps the letters a changed text shares with the old one", () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, { speed: 10 }), {
      initialProps: { text: "Reading 2 of 3" },
    });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.shown).toBe("Reading 2 of 3");
    rerender({ text: "Reading 3 of 3" });
    // Only the changed digit is typed again.
    expect(result.current.shown).toBe("Reading ");
    act(() => vi.advanceTimersByTime(10));
    expect(result.current.shown).toBe("Reading 3");
  });

  it("shows everything at once for reduced motion", () => {
    reduceMotion(true);
    const { result } = renderHook(() => useTypewriter("hello", { speed: 10 }));
    expect(result.current).toEqual({ shown: "hello", typing: false });
  });

  it("reports when it finishes", () => {
    const onDone = vi.fn();
    renderHook(() => useTypewriter("hi", { speed: 10, onDone }));
    act(() => vi.advanceTimersByTime(10));
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(10));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("Typewriter", () => {
  it("gives screen readers the whole sentence and hides the partial one", () => {
    render(<Typewriter text="Finished reading" speed={10} />);
    expect(screen.getByText("Finished reading", { selector: ".sr-only" })).toBeInTheDocument();
    const visible = document.querySelector("[aria-hidden=true]");
    expect(visible).toHaveTextContent("");
    act(() => vi.advanceTimersByTime(80));
    expect(visible).toHaveTextContent("Finished");
  });
});

describe("useTypewriterCycle", () => {
  it("types a phrase, holds, erases it, then starts the next", () => {
    const { result } = renderHook(() =>
      useTypewriterCycle(["ab", "cd"], { typeSpeed: 10, eraseSpeed: 10, hold: 100 }),
    );
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(30));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(10));
    expect(result.current).toBe("ab");
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(10));
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(40));
    expect(result.current).toBe("c");
  });

  it("stays empty while inactive and static for reduced motion", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useTypewriterCycle(["ab", "cd"], { active }),
      { initialProps: { active: false } },
    );
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe("");
    reduceMotion(true);
    rerender({ active: true });
    expect(result.current).toBe("ab");
  });
});

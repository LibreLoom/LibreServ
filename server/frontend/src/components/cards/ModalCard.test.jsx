import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ModalCard, { useModalClose, EXIT_ANIMATION_MS, POP_IN_ANIMATION_MS } from "./ModalCard";

afterEach(() => {
  vi.useRealTimers();
  document.body.style.overflow = "";
});

describe("ModalCard", () => {
  it("delays onClose until exit animation finishes", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <ModalCard title="Test modal" onClose={onClose}>
        {({ close }) => (
          <button type="button" onClick={close}>
            Not now
          </button>
        )}
      </ModalCard>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog").closest("[data-slot=dialog-overlay]"))
      .toHaveClass("animate-out");

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("exposes useModalClose for nested dismiss controls", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    function InnerDismiss() {
      const close = useModalClose();
      return (
        <button type="button" onClick={close}>
          Dismiss
        </button>
      );
    }

    render(
      <ModalCard title="Nested" onClose={onClose}>
        <InnerDismiss />
      </ModalCard>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("animates out when controlled open becomes false without calling onClose again", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(
      <ModalCard open title="Controlled" onClose={onClose}>
        Body
      </ModalCard>,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(
      <ModalCard open={false} title="Controlled" onClose={onClose}>
        Body
      </ModalCard>,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog").closest("[data-slot=dialog-overlay]"))
      .toHaveClass("animate-out");
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hides scroller overflow as soon as close starts pop-out", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <ModalCard title="Close overflow" onClose={onClose}>
        {({ close }) => (
          <button type="button" onClick={close}>
            Done
          </button>
        )}
      </ModalCard>,
    );

    act(() => {
      vi.advanceTimersByTime(POP_IN_ANIMATION_MS);
    });

    const scroller = screen.getByRole("dialog").querySelector("[data-slot=dialog-scroller]");
    expect(scroller).toHaveClass("overflow-y-auto");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(scroller).toHaveClass("overflow-hidden");
    expect(scroller).not.toHaveClass("overflow-y-auto");
    expect(screen.getByRole("dialog").querySelector(".pop-out")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS - 1);
    });
    expect(scroller).toHaveClass("overflow-hidden");
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides scroller overflow when controlled open becomes false", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ModalCard open title="Controlled overflow" onClose={() => {}}>
        Body
      </ModalCard>,
    );

    act(() => {
      vi.advanceTimersByTime(POP_IN_ANIMATION_MS);
    });

    const scroller = screen.getByRole("dialog").querySelector("[data-slot=dialog-scroller]");
    expect(scroller).toHaveClass("overflow-y-auto");

    rerender(
      <ModalCard open={false} title="Controlled overflow" onClose={() => {}}>
        Body
      </ModalCard>,
    );

    expect(scroller).toHaveClass("overflow-hidden");
    expect(scroller).not.toHaveClass("overflow-y-auto");
    expect(screen.getByRole("dialog").closest("[data-slot=dialog-overlay]"))
      .toHaveClass("animate-out");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("unlocks scroller overflow after the pop-in fallback duration", () => {
    vi.useFakeTimers();
    render(
      <ModalCard title="Scroll fallback" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    const scroller = screen.getByRole("dialog").querySelector("[data-slot=dialog-scroller]");
    expect(scroller).toHaveClass("overflow-hidden");

    act(() => {
      vi.advanceTimersByTime(POP_IN_ANIMATION_MS);
    });

    expect(scroller).toHaveClass("overflow-y-auto");
  });

  it("allows scroller overflow immediately when motion is reduced", () => {
    const original = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: String(query).includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
    try {
      render(
        <ModalCard title="Reduced motion" onClose={() => {}}>
          Body
        </ModalCard>,
      );
      const scroller = screen.getByRole("dialog").querySelector("[data-slot=dialog-scroller]");
      expect(scroller).toHaveClass("overflow-y-auto");
      expect(scroller).not.toHaveClass("overflow-hidden");
    } finally {
      window.matchMedia = original;
    }
  });

  it("stays unmounted while open is false", () => {
    render(
      <ModalCard open={false} title="Hidden" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("measures height from dialog-measure, not the max-height scroller", () => {
    render(
      <ModalCard title="Measure" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    const dialog = screen.getByRole("dialog");
    const scroller = dialog.querySelector("[data-slot=dialog-scroller]");
    const measure = dialog.querySelector("[data-slot=dialog-measure]");
    expect(scroller).toBeTruthy();
    expect(measure).toBeTruthy();
    expect(scroller?.contains(measure)).toBe(true);
    expect(measure).not.toBe(scroller);
    expect(dialog.className).toMatch(/transition-\[.*height.*\]/);
    expect(dialog.className).toMatch(/transition-\[.*max-width.*\]/);
    expect(dialog.className).toMatch(/motion-reduce:transition-none/);
  });

  it("updates width classes when size changes", () => {
    const { rerender } = render(
      <ModalCard size="sm" title="Size test" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("sm:max-w-md");

    rerender(
      <ModalCard size="lg" title="Size test" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    expect(dialog).toHaveClass("sm:max-w-3xl");

    rerender(
      <ModalCard size="fullscreen" title="Size test" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    expect(dialog).toHaveClass("max-w-[95vw]");
  });
});


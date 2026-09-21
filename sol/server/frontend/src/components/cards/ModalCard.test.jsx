import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ModalCard, { useModalClose, EXIT_ANIMATION_MS, POP_IN_ANIMATION_MS } from "./ModalCard";
import { HEIGHT_SETTLE_MS } from "../../hooks/useAnimatedHeight";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

/**
 * Stub ResizeObserver and pin dialog-measure offsetHeight for height/scroll tests.
 * @returns {{ callbacks: ResizeObserverCallback[], setMeasureHeight: (n: number) => void }}
 */
function stubMeasureHeight(initialHeight = 80) {
  /** @type {ResizeObserverCallback[]} */
  const callbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      /** @param {ResizeObserverCallback} cb */
      constructor(cb) {
        callbacks.push(cb);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  let measureHeight = initialHeight;
  return {
    callbacks,
    setMeasureHeight(n) {
      measureHeight = n;
    },
    /** @param {Element | null} measure */
    bindMeasure(measure) {
      Object.defineProperty(/** @type {HTMLElement} */ (measure), "offsetHeight", {
        configurable: true,
        get: () => measureHeight,
      });
    },
  };
}

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
    const { callbacks, setMeasureHeight, bindMeasure } = stubMeasureHeight(500);
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

    const dialog = screen.getByRole("dialog");
    dialog.style.maxHeight = "200px";
    bindMeasure(dialog.querySelector("[data-slot=dialog-measure]"));
    setMeasureHeight(500);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    act(() => {
      vi.advanceTimersByTime(Math.max(POP_IN_ANIMATION_MS, HEIGHT_SETTLE_MS));
    });

    const scroller = dialog.querySelector("[data-slot=dialog-scroller]");
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
    const { callbacks, setMeasureHeight, bindMeasure } = stubMeasureHeight(500);
    const { rerender } = render(
      <ModalCard open title="Controlled overflow" onClose={() => {}}>
        Body
      </ModalCard>,
    );

    const dialog = screen.getByRole("dialog");
    dialog.style.maxHeight = "200px";
    bindMeasure(dialog.querySelector("[data-slot=dialog-measure]"));
    setMeasureHeight(500);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    act(() => {
      vi.advanceTimersByTime(Math.max(POP_IN_ANIMATION_MS, HEIGHT_SETTLE_MS));
    });

    const scroller = dialog.querySelector("[data-slot=dialog-scroller]");
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

  it("keeps overflow hidden after pop-in when content fits (modal can still grow)", () => {
    vi.useFakeTimers();
    render(
      <ModalCard title="Fits" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    const scroller = screen.getByRole("dialog").querySelector("[data-slot=dialog-scroller]");
    expect(scroller).toHaveClass("overflow-hidden");

    act(() => {
      vi.advanceTimersByTime(POP_IN_ANIMATION_MS);
    });

    expect(scroller).toHaveClass("overflow-hidden");
    expect(scroller).not.toHaveClass("overflow-y-auto");
  });

  it("enables overflow-y-auto when content exceeds max-height after pop-in", () => {
    vi.useFakeTimers();
    const { callbacks, setMeasureHeight, bindMeasure } = stubMeasureHeight(500);
    render(
      <ModalCard title="Tall" onClose={() => {}}>
        Body
      </ModalCard>,
    );

    const dialog = screen.getByRole("dialog");
    const scroller = dialog.querySelector("[data-slot=dialog-scroller]");
    dialog.style.maxHeight = "200px";
    bindMeasure(dialog.querySelector("[data-slot=dialog-measure]"));
    setMeasureHeight(500);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    act(() => {
      vi.advanceTimersByTime(Math.max(POP_IN_ANIMATION_MS, HEIGHT_SETTLE_MS));
    });

    expect(scroller).toHaveClass("overflow-y-auto");
    expect(scroller).toHaveClass("overflow-x-hidden");
  });

  it("hides scroller overflow while height animates to taller content that still fits", () => {
    vi.useFakeTimers();
    const { callbacks, setMeasureHeight, bindMeasure } = stubMeasureHeight(80);

    render(
      <ModalCard title="Growing" onClose={() => {}}>
        Body
      </ModalCard>,
    );

    const dialog = screen.getByRole("dialog");
    // Room to grow: max is far above content.
    dialog.style.maxHeight = "800px";
    const measure = dialog.querySelector("[data-slot=dialog-measure]");
    expect(measure).toBeTruthy();
    bindMeasure(measure);

    // Seed the initial measured height (first apply does not flag animating).
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    act(() => {
      vi.advanceTimersByTime(Math.max(POP_IN_ANIMATION_MS, HEIGHT_SETTLE_MS));
    });

    const scroller = dialog.querySelector("[data-slot=dialog-scroller]");
    expect(scroller).toHaveClass("overflow-hidden");
    expect(scroller).not.toHaveClass("overflow-y-auto");

    setMeasureHeight(360);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    expect(scroller).toHaveClass("overflow-hidden");
    expect(scroller).not.toHaveClass("overflow-y-auto");

    act(() => {
      vi.advanceTimersByTime(HEIGHT_SETTLE_MS);
    });
    // Still fits under max-height — no scrollbar after settle either.
    expect(scroller).toHaveClass("overflow-hidden");
    expect(scroller).not.toHaveClass("overflow-y-auto");
  });

  it("allows overflow-y-auto after settle only when growth hits max-height", () => {
    vi.useFakeTimers();
    const { callbacks, setMeasureHeight, bindMeasure } = stubMeasureHeight(80);

    render(
      <ModalCard title="Cap" onClose={() => {}}>
        Body
      </ModalCard>,
    );

    const dialog = screen.getByRole("dialog");
    dialog.style.maxHeight = "200px";
    bindMeasure(dialog.querySelector("[data-slot=dialog-measure]"));

    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    act(() => {
      vi.advanceTimersByTime(Math.max(POP_IN_ANIMATION_MS, HEIGHT_SETTLE_MS));
    });

    const scroller = dialog.querySelector("[data-slot=dialog-scroller]");
    expect(scroller).toHaveClass("overflow-hidden");

    setMeasureHeight(500);
    act(() => {
      callbacks.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });
    // While height eases toward the cap, keep clipped.
    expect(scroller).toHaveClass("overflow-hidden");
    expect(scroller).not.toHaveClass("overflow-y-auto");

    act(() => {
      vi.advanceTimersByTime(HEIGHT_SETTLE_MS);
    });
    expect(scroller).toHaveClass("overflow-y-auto");
    expect(scroller).toHaveClass("overflow-x-hidden");
  });

  it("keeps overflow hidden when motion is reduced and content fits", () => {
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
      expect(scroller).toHaveClass("overflow-hidden");
      expect(scroller).not.toHaveClass("overflow-y-auto");
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

  it("uses a viewport-absolute max-height instead of max-h-full", () => {
    render(
      <ModalCard title="Cap" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    expect(dialog.className).toMatch(/sm:max-h-\[calc\(95vh-4rem\)\]/);
    expect(dialog.className).not.toMatch(/\bmax-h-full\b/);
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

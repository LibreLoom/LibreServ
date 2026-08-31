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

  it("stays unmounted while open is false", () => {
    render(
      <ModalCard open={false} title="Hidden" onClose={() => {}}>
        Body
      </ModalCard>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

  it("applies overlayClassName on the fixed overlay for stacking", () => {
    render(
      <ModalCard title="Stacked" onClose={() => {}} overlayClassName="z-[90]">
        Body
      </ModalCard>,
    );
    expect(screen.getByRole("dialog").closest("[data-slot=dialog-overlay]")).toHaveClass(
      "z-[90]",
    );
  });

  it("Escape on a nested overlay closes only the top modal", () => {
    vi.useFakeTimers();
    const onBottom = vi.fn();
    const onTop = vi.fn();
    render(
      <>
        <ModalCard title="Bottom" onClose={onBottom}>
          Under
        </ModalCard>
        <ModalCard title="Top" onClose={onTop} overlayClassName="z-[90]">
          Over
        </ModalCard>
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onBottom).not.toHaveBeenCalled();
    expect(onTop).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    });

    expect(onTop).toHaveBeenCalledTimes(1);
    expect(onBottom).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Bottom" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Top" })).not.toBeInTheDocument();
  });
});

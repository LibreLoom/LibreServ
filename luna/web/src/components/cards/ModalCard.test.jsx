import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ModalCard, { useModalClose } from "./ModalCard";

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
      vi.advanceTimersByTime(300);
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
      vi.advanceTimersByTime(300);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

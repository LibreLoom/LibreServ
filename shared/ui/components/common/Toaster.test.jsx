import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastProvider, useToast } from "../../context/ToastContext.jsx";
import Toaster from "./Toaster.jsx";

function Trigger({ options }) {
  const { addToast } = useToast();
  return (
    <button
      type="button"
      onClick={() => addToast({ message: "Saved", type: "success", ...options })}
    >
      raise
    </button>
  );
}

function setup(options = {}) {
  render(
    <ToastProvider>
      <Trigger options={options} />
      <Toaster />
    </ToastProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "raise" }));
}

const toast = () => screen.queryByRole("status");
const raiseButton = () => screen.getByRole("button", { name: "raise" });

describe("Toaster", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dismisses on a swipe past the distance threshold", () => {
    setup({ duration: 0 });
    const el = toast();
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: "touch", clientX: 120, clientY: 0 });
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: "touch", clientX: 120, clientY: 0 });

    expect(el).toHaveStyle({ opacity: "0" });
    act(() => vi.advanceTimersByTime(500));
    expect(toast()).not.toBeInTheDocument();
  });

  it("snaps back when the drag does not cross the threshold", () => {
    setup({ duration: 0 });
    const el = toast();
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 0 });
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 0 });

    act(() => vi.advanceTimersByTime(300));
    expect(toast()).toBeInTheDocument();
    expect(toast()).not.toHaveClass("animate-toast-exit");
  });

  it("pauses while focus is inside the toast", () => {
    setup({ duration: 1000, action: { label: "Undo", onClick: () => {} } });
    screen.getByRole("button", { name: "Undo" }).focus();

    act(() => vi.advanceTimersByTime(2000));
    expect(toast()).toBeInTheDocument();
  });

  it("pauses while a touch is held on the toast and resumes on outside interaction", () => {
    setup({ duration: 1000 });
    const el = toast();
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 });

    act(() => vi.advanceTimersByTime(1500));
    expect(toast()).toBeInTheDocument();

    fireEvent.pointerDown(raiseButton(), {
      pointerId: 2,
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
    });
    act(() => vi.advanceTimersByTime(1500));
    expect(toast()).not.toBeInTheDocument();
  });

  it("does not treat a touch's synthetic pointer-over as a mouse hover", () => {
    setup({ duration: 1000 });
    fireEvent.pointerOver(toast(), { pointerType: "touch" });

    act(() => vi.advanceTimersByTime(1500));
    expect(toast()).not.toBeInTheDocument();
  });

  it("still pauses on a real mouse hover", () => {
    setup({ duration: 1000 });
    fireEvent.pointerOver(toast(), { pointerType: "mouse" });

    act(() => vi.advanceTimersByTime(1500));
    expect(toast()).toBeInTheDocument();
  });

  it("dismisses on Escape when a control inside the toast has focus", () => {
    setup({ duration: 0, action: { label: "Undo", onClick: () => {} } });
    const undo = screen.getByRole("button", { name: "Undo" });
    undo.focus();
    fireEvent.keyDown(undo, { key: "Escape" });

    act(() => vi.advanceTimersByTime(500));
    expect(toast()).not.toBeInTheDocument();
  });

  it("pauses while the tab is hidden and resumes when it is shown again", () => {
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    const setHidden = (value) =>
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => value,
      });

    try {
      setup({ duration: 1000 });
      setHidden(true);
      fireEvent(document, new Event("visibilitychange"));
      act(() => vi.advanceTimersByTime(2000));
      expect(toast()).toBeInTheDocument();

      setHidden(false);
      fireEvent(document, new Event("visibilitychange"));
      act(() => vi.advanceTimersByTime(1500));
      expect(toast()).not.toBeInTheDocument();
    } finally {
      if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
      else delete document.hidden;
    }
  });
});

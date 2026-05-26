import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./ToastContext.jsx";

describe("ToastContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("useToast throws when used outside provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useToast())).toThrow("useToast must be used within a ToastProvider");
    consoleError.mockRestore();
  });

  it("adds a toast and returns its id", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    let id;
    act(() => {
      id = result.current.addToast({ message: "Hello", type: "info" });
    });
    expect(id).toBeGreaterThan(0);
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].message).toBe("Hello");
    expect(result.current.toasts[0].type).toBe("info");
  });

  it("adds a success toast with default duration", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "Success!", type: "success" });
    });
    expect(result.current.toasts[0].type).toBe("success");
  });

  it("adds an error toast", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "Error!", type: "error" });
    });
    expect(result.current.toasts[0].type).toBe("error");
  });

  it("dismisses a toast", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    let id;
    act(() => {
      id = result.current.addToast({ message: "Test" });
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      result.current.dismissToast(id);
    });
    expect(result.current.toasts[0].exiting).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("auto-dismisses after duration", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "Auto dismiss", type: "info", duration: 1000 });
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.toasts[0].exiting).toBe(true);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("clears all toasts", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "One" });
      result.current.addToast({ message: "Two" });
    });
    expect(result.current.toasts).toHaveLength(2);

    act(() => {
      result.current.clearToasts();
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("respects maxToasts limit", () => {
    const wrapper = ({ children }) => <ToastProvider maxToasts={2}>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "First" });
      result.current.addToast({ message: "Second" });
      result.current.addToast({ message: "Third" });
    });
    expect(result.current.toasts).toHaveLength(2);
    expect(result.current.toasts[0].message).toBe("Second");
    expect(result.current.toasts[1].message).toBe("Third");
  });

  it("supports toast with description", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "Warning", description: "Something happened", type: "info" });
    });
    expect(result.current.toasts[0].description).toBe("Something happened");
  });

  it("persists toast when duration is 0", () => {
    const wrapper = ({ children }) => <ToastProvider>{children}</ToastProvider>;
    const { result } = renderHook(() => useToast(), { wrapper });

    act(() => {
      result.current.addToast({ message: "Sticky", duration: 0 });
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(99999);
    });
    expect(result.current.toasts).toHaveLength(1);
  });
});

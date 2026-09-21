import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIsNarrow } from "./useIsNarrow.jsx";

describe("useIsNarrow", () => {
  let mockObserve = vi.fn();
  let mockDisconnect = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    mockObserve = vi.fn();
    mockDisconnect = vi.fn();
    globalThis.ResizeObserver = vi.fn(() => ({
      observe: mockObserve,
      disconnect: mockDisconnect,
      unobserve: vi.fn(),
    }));
  });

  afterEach(() => {
    delete globalThis.ResizeObserver;
  });

  it("returns false initially", () => {
    const { result } = renderHook(() => useIsNarrow(220));
    expect(result.current[0]).toBe(false);
  });

  it("returns a ref to attach to element", () => {
    const { result } = renderHook(() => useIsNarrow());
    expect(result.current[1]).toHaveProperty("current");
  });
});

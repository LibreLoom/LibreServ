import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useErrorHandler, useApiErrorHandler, withErrorHandling } from "./useErrorHandler.jsx";

describe("useErrorHandler", () => {
  it("starts with no error", () => {
    const { result } = renderHook(() => useErrorHandler());
    expect(result.current.error).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("setError stores an Error object", () => {
    const { result } = renderHook(() => useErrorHandler());
    act(() => result.current.setError(new Error("test error")));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error.message).toBe("test error");
    expect(result.current.isError).toBe(true);
  });

  it("setError converts string to Error", () => {
    const { result } = renderHook(() => useErrorHandler());
    act(() => result.current.setError("string error"));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error.message).toBe("string error");
  });

  it("setError handles unknown types", () => {
    const { result } = renderHook(() => useErrorHandler());
    act(() => result.current.setError(42));
    expect(result.current.error.message).toBe("An unknown error occurred");
  });

  it("clearError resets error to null", () => {
    const { result } = renderHook(() => useErrorHandler());
    act(() => result.current.setError(new Error("test")));
    expect(result.current.isError).toBe(true);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it("handleError wraps async function and catches errors", async () => {
    const { result } = renderHook(() => useErrorHandler());
    const fn = vi.fn().mockRejectedValue(new Error("async error"));
    const wrapped = result.current.handleError(fn);

    await expect(wrapped()).rejects.toThrow("async error");
    await vi.waitFor(() => {
      expect(result.current.error.message).toBe("async error");
    });
  });

  it("handleError clears previous error before running", async () => {
    const { result } = renderHook(() => useErrorHandler());
    act(() => result.current.setError(new Error("old error")));
    const fn = vi.fn().mockResolvedValue("success");
    const wrapped = result.current.handleError(fn);

    const val = await wrapped();
    expect(val).toBe("success");
    await vi.waitFor(() => expect(result.current.error).toBeNull());
  });

  it("withErrorHandling delegates to handleError", () => {
    const { result } = renderHook(() => useErrorHandler());
    const fn = vi.fn();
    const wrapped = result.current.withErrorHandling(fn);
    expect(wrapped).toBeInstanceOf(Function);
  });
});

describe("useApiErrorHandler", () => {
  it("handles 401 errors", () => {
    const { result } = renderHook(() => useApiErrorHandler());
    const err = /** @type {any} */ (new Error("unauthorized"));
    err.cause = { status: 401 };
    act(() => result.current.handleApiError(err));
    expect(result.current.error.message).toContain("session has expired");
  });

  it("handles 403 errors", () => {
    const { result } = renderHook(() => useApiErrorHandler());
    const err = /** @type {any} */ (new Error("forbidden"));
    err.cause = { status: 403 };
    act(() => result.current.handleApiError(err));
    expect(result.current.error.message).toContain("do not have permission");
  });

  it("handles 404 errors", () => {
    const { result } = renderHook(() => useApiErrorHandler());
    const err = /** @type {any} */ (new Error("not found"));
    err.cause = { status: 404 };
    act(() => result.current.handleApiError(err));
    expect(result.current.error.message).toContain("was not found");
  });

  it("handles 429 errors", () => {
    const { result } = renderHook(() => useApiErrorHandler());
    const err = /** @type {any} */ (new Error("rate limited"));
    err.cause = { status: 429 };
    act(() => result.current.handleApiError(err));
    expect(result.current.error.message).toContain("Too many requests");
  });

  it("handles 5xx errors", () => {
    const { result } = renderHook(() => useApiErrorHandler());
    for (const code of [500, 502, 503]) {
      act(() => result.current.clearError());
      const err = /** @type {any} */ (new Error("server error"));
      err.cause = { status: code };
      act(() => result.current.handleApiError(err));
      expect(result.current.error.message).toBe("Server error. Please try again later.");
    }
  });

  it("handles network errors", () => {
    const { result } = renderHook(() => useApiErrorHandler());
    act(() => result.current.handleApiError(new Error("NetworkError: fetch failed")));
    expect(result.current.error.message).toContain("Network error");
  });

  it("handleApiCall wraps async function and catches API errors", async () => {
    const { result } = renderHook(() => useApiErrorHandler());
    const fn = vi.fn().mockRejectedValue({ cause: { status: 401 }, message: "fail" });

    await expect(result.current.handleApiCall(fn)()).rejects.toBeDefined();
    await vi.waitFor(() => {
      expect(result.current.error.message).toContain("session has expired");
    });
  });
});

describe("withErrorHandling HOC", () => {
  it("returns a component wrapping the original", () => {
    const MockComp = /** @type {any} */ (vi.fn().mockReturnValue(null));
    const Wrapped = withErrorHandling(MockComp);
    expect(Wrapped).toBeInstanceOf(Function);
  });
});

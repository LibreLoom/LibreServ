import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "../context/AuthContextContext.js";
import { useApps, useInvalidateApps } from "./useApps.jsx";

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const request = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ apps: [{ id: "1", name: "Nextcloud", app_id: "nextcloud", status: "running" }] }),
  });
  const authValue = { me: { id: "u1" }, csrfToken: "tok", request, initialized: true };
  return {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    ),
    request,
  };
}

describe("useApps", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns empty array when no apps", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const request = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ me: {}, csrfToken: "tok", request, initialized: true }}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useApps(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it("fetches and returns apps", async () => {
    const { wrapper, request } = createWrapper();
    const { result } = renderHook(() => useApps(), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].name).toBe("Nextcloud");
    });
    expect(request).toHaveBeenCalledWith("/apps");
  });

  it("respects custom refresh interval", () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useApps(5000), { wrapper });
    expect(result.current.data).toBeUndefined();
  });
});

describe("useInvalidateApps", () => {
  it("returns a function that invalidates apps query", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInvalidateApps(), { wrapper });
    result.current();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["apps"] });
  });
});

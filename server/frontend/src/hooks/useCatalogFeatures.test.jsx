import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "../context/AuthContextContext.js";
import { useCatalogFeatures } from "./useCatalogFeatures.jsx";

describe("useCatalogFeatures", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("fetches features for a given appId", async () => {
    const request = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ features: ["backup", "monitoring"] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ me: {}, csrfToken: "tok", request, initialized: true }}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useCatalogFeatures("nextcloud"), { wrapper });
    await waitFor(() => {
      expect(result.current.data.features).toEqual(["backup", "monitoring"]);
    });
    expect(request).toHaveBeenCalledWith("/catalog/nextcloud/features");
  });

  it("is disabled when appId is empty", () => {
    const request = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ me: {}, csrfToken: "tok", request, initialized: true }}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useCatalogFeatures(""), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(request).not.toHaveBeenCalled();
  });

  it("handles fetch errors", async () => {
    const request = vi.fn().mockRejectedValue(new Error("fail"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ me: {}, csrfToken: "tok", request, initialized: true }}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useCatalogFeatures("nextcloud"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

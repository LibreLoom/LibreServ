import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "../context/AuthContextContext.js";
import { useCatalog } from "./useCatalog.jsx";

describe("useCatalog", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns empty array when no apps in catalog", async () => {
    const request = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ me: {}, csrfToken: "tok", request, initialized: true }}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useCatalog(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it("fetches and returns catalog apps", async () => {
    const apps = [{ id: "nextcloud", name: "Nextcloud", category: "cloud" }];
    const request = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ apps }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ me: {}, csrfToken: "tok", request, initialized: true }}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useCatalog(), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data[0].id).toBe("nextcloud");
    });
    expect(request).toHaveBeenCalledWith("/catalog");
  });

  it("handles fetch errors", async () => {
    const request = vi.fn().mockRejectedValue(new Error("network failure"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={{ me: {}, csrfToken: "tok", request, initialized: true }}>{children}</AuthContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useCatalog(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

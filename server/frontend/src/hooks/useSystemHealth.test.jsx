import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSystemHealth } from "./useSystemHealth.jsx";

vi.mock("../lib/api", () => ({
  default: vi.fn(),
}));

import api from "../lib/api";

describe("useSystemHealth", () => {
  it("returns health data when API succeeds", async () => {
    api.mockResolvedValue({
      json: () => Promise.resolve({ status: "ok", checks: { cpu: "passed" } }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useSystemHealth(), { wrapper });
    await waitFor(() => {
      expect(result.current.data.status).toBe("ok");
      expect(result.current.data.checks.cpu).toBe("passed");
    });
  });

  it("handles API errors", async () => {
    api.mockRejectedValue(new Error("fail"));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useSystemHealth(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5000 });
  });
});

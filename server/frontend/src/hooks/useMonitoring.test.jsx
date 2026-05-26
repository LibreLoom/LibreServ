import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMonitoring } from "./useMonitoring.jsx";

vi.mock("../lib/api", () => ({
  default: vi.fn(),
}));

import api from "../lib/api";

describe("useMonitoring", () => {
  it("returns resources when API succeeds", async () => {
    api.mockResolvedValue({
      json: () => Promise.resolve({ resources: { cpu: 0.5, ram: 0.3, disk: 0.2, net: 0.1 } }),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toEqual({ cpu: 0.5, ram: 0.3, disk: 0.2, net: 0.1 });
    });
  });

  it("throws error when resources are missing", async () => {
    api.mockResolvedValue({
      json: () => Promise.resolve({}),
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useMonitoring(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("passes refreshInterval to query", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMonitoring(15000), { wrapper });
    expect(result.current.data).toBeUndefined();
  });
});

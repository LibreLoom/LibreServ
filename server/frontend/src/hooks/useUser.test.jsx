import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUser } from "./useUser.jsx";

vi.mock("../lib/api", () => ({
  default: vi.fn(),
}));

import api from "../lib/api";

describe("useUser", () => {
  it("returns user data when API succeeds", async () => {
    api.mockResolvedValue({ json: () => Promise.resolve({ id: "u1", username: "admin" }) });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useUser(), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toEqual({ id: "u1", username: "admin" });
    });
  });

  it("handles API errors gracefully", async () => {
    api.mockRejectedValue(new Error("fail"));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useUser(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

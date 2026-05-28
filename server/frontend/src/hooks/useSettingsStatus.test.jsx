import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSettingsStatus } from "./useSettingsStatus.jsx";

vi.mock("../lib/api", () => ({
  default: vi.fn(),
}));

import api from "../lib/api";

describe("useSettingsStatus", () => {
  it("returns false for both when API fails", async () => {
    vi.mocked(api).mockRejectedValue(new Error("fail"));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useSettingsStatus(), { wrapper });
    await waitFor(() => {
      expect(result.current.smtpConfigured).toBe(false);
      expect(result.current.domainConfigured).toBe(false);
    });
  });

  it("detects SMTP and domain configured", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(/** @type {any} */({
        json: () => Promise.resolve({ checks: { smtp: { status: "passed", details: {} } } }),
      }))
      .mockResolvedValueOnce(/** @type {any} */({
        json: () => Promise.resolve({ proxy: { default_domain: "example.com" } }),
      }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useSettingsStatus(), { wrapper });
    await waitFor(() => {
      expect(result.current.smtpConfigured).toBe(true);
      expect(result.current.domainConfigured).toBe(true);
    });
  });

  it("detects optional SMTP as not configured", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(/** @type {any} */({
        json: () => Promise.resolve({ checks: { smtp: { status: "passed", details: { optional: true } } } }),
      }))
      .mockResolvedValueOnce(/** @type {any} */({
        json: () => Promise.resolve({ proxy: { default_domain: "example.com" } }),
      }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useSettingsStatus(), { wrapper });
    await waitFor(() => {
      expect(result.current.smtpConfigured).toBe(false);
    });
  });

  it("detects localhost domain as not configured", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(/** @type {any} */({
        json: () => Promise.resolve({ checks: { smtp: { status: "passed", details: {} } } }),
      }))
      .mockResolvedValueOnce(/** @type {any} */({
        json: () => Promise.resolve({ proxy: { default_domain: "localhost" } }),
      }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useSettingsStatus(), { wrapper });
    await waitFor(() => {
      expect(result.current.domainConfigured).toBe(false);
    });
  });
});

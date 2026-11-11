import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import useSettingsSearch from "./useSettingsSearch.jsx";

vi.mock("@libreloom/ui/lib/settingsSearch.js", () => ({
  buildSettingsIndex: vi.fn(),
  searchSettings: vi.fn(() => []),
}));

import { buildSettingsIndex } from "@libreloom/ui/lib/settingsSearch.js";

describe("useSettingsSearch", () => {
  it("keeps one index build when the query and overlay visibility change", async () => {
    let finish;
    vi.mocked(buildSettingsIndex).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const client = new QueryClient();
    const categories = [{ id: "appearance", label: "Appearance" }];
    const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ query, preload }) => useSettingsSearch(categories, query, preload), {
      initialProps: { query: "", preload: true }, wrapper,
    });
    await waitFor(() => expect(buildSettingsIndex).toHaveBeenCalledTimes(1));
    rerender({ query: "t", preload: true });
    rerender({ query: "theme", preload: true });
    rerender({ query: "", preload: false });
    rerender({ query: "theme", preload: true });
    expect(buildSettingsIndex).toHaveBeenCalledTimes(1);
    await act(async () => { finish([]); });
    await waitFor(() => expect(result.current.results).toEqual([]));
    expect(buildSettingsIndex).toHaveBeenCalledTimes(1);
  });

  it("builds again when the categories this person can see change", async () => {
    vi.mocked(buildSettingsIndex).mockReset();
    vi.mocked(buildSettingsIndex).mockImplementation(async () => []);
    const client = new QueryClient();
    const wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ categories }) => useSettingsSearch(categories, "", true), {
      initialProps: { categories: [{ id: "appearance", label: "Appearance" }] }, wrapper,
    });
    await waitFor(() => expect(buildSettingsIndex).toHaveBeenCalledTimes(1));
    // A new list with the same categories is not a reason to build again.
    rerender({ categories: [{ id: "appearance", label: "Appearance" }] });
    expect(buildSettingsIndex).toHaveBeenCalledTimes(1);
    // Becoming an Admin (or Connect turning on) adds a category to search.
    rerender({ categories: [{ id: "appearance", label: "Appearance" }, { id: "users", label: "Users" }] });
    await waitFor(() => expect(buildSettingsIndex).toHaveBeenCalledTimes(2));
    expect(vi.mocked(buildSettingsIndex).mock.calls[1][0].map((c) => c.id)).toEqual(["appearance", "users"]);
    expect(result.current.results).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";
import { AuthProvider } from "../../context/AuthContext.jsx";
import { FileOpsProvider } from "../../context/FileOpsContext.jsx";
import FileSearch, { FileSearchButton } from "./FileSearch.jsx";

const fixture = vi.hoisted(() => ({ results: /** @type {any[]} */ ([]) }));
vi.mock("../settings/useSettingsSearch.jsx", () => ({
  default: () => ({ results: fixture.results, prepare: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

describe("search settings result limit", () => {
  it.each([4, 5])("shows four of %i remaining settings and expands only when needed", async (remaining) => {
    fixture.results = Array.from({ length: remaining + 1 }, (_, index) => ({
      kind: "row", categoryId: "appearance", categoryLabel: "Appearance", cardTitle: "Theme",
      title: index === 0 ? "Theme" : `Theme option ${index}`, text: "",
    }));
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = String(url);
      const value = path.includes("/auth/me") ? { id: "1", role: "admin", username: "admin" }
        : path.includes("/auth/status") ? { has_admin: true, connect_active: false }
          : path.includes("/setup") ? { setup_completed: true }
            : path.includes("/search") ? { hits: [], scan: { scanning: false } } : [];
      return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><ShortcutsProvider><QueryClientProvider client={client}><MemoryRouter><AuthProvider><FileOpsProvider>
      <FileSearchButton /><FileSearch />
    </FileOpsProvider></AuthProvider></MemoryRouter></QueryClientProvider></ShortcutsProvider></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Search Luna" }), { target: { value: "theme" } });
    const dialog = screen.getByRole("dialog", { name: "Search Luna" });
    for (let index = 1; index <= 4; index++) expect(within(dialog).getByText(`Theme option ${index}`)).toBeInTheDocument();
    const more = within(dialog).queryByRole("button", { name: "Show more settings" });
    if (remaining === 4) {
      expect(more).not.toBeInTheDocument();
    } else {
      expect(within(dialog).queryByText("Theme option 5")).not.toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole("button", { name: "Show more settings" }));
      expect(within(dialog).getByText("Theme option 5")).toBeInTheDocument();
    }
  });
});

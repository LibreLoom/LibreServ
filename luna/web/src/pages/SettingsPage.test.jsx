import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import SettingsPage, { RECOVERY_CARD } from "./SettingsPage";

function stubFetch(role = "admin") {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me")) {
      return new Response(JSON.stringify({ id: "1", username: "max", role }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/api/v1/setup")) {
      return new Response(JSON.stringify({ name: "Luna", setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/system/updates")) {
      return new Response(JSON.stringify({
        current_version: "0.1.0",
        latest_version: "luna-v0.1.0",
        update_available: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/device-tokens")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/connect/status")) {
      return new Response(JSON.stringify({ enabled: false, backup_unlocked: false, backup_sources: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/api/v1/drives")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/network/")) {
      return new Response(JSON.stringify({
        connected: false,
        available: true,
        ethernet_connected: true,
        wifi_connected: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }));
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <SettingsPage />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/settings");
    window.matchMedia = (query) => ({
      matches: String(query).includes("min-width: 768px"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (typeof globalThis.localStorage === "undefined" || !globalThis.localStorage?.getItem) {
      const store = new Map();
      globalThis.localStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => { store.set(String(key), String(value)); },
        removeItem: (key) => { store.delete(String(key)); },
        clear: () => { store.clear(); },
      };
    }
  });

  it("uses a category sidebar and opens the keyboard recovery card from it", async () => {
    stubFetch("admin");
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("navigation", { name: /Settings categories/i })).toBeTruthy();
    expect(await screen.findByText("max")).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "Look and feel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Match device/i })).toBeTruthy();
    expect(screen.queryByText(/Plug a USB keyboard into Luna/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: RECOVERY_CARD.title }));
    expect(await screen.findByRole("heading", { level: 1, name: RECOVERY_CARD.title })).toBeTruthy();
    expect(screen.getByText(/Plug a USB keyboard into Luna/i)).toBeTruthy();
    expect(screen.getByText(/Press Esc, then type luna, then press Enter/i)).toBeTruthy();
  });

  it("keeps sign-out, tokens, and updates behind their own categories", async () => {
    stubFetch("admin");
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("max");

    await user.click(screen.getByRole("button", { name: /Who is signed in/i }));
    expect(await screen.findByRole("button", { name: /Sign out every browser/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Revoke app access/i })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Apps and access tokens" }));
    expect(await screen.findByRole("button", { name: /Create access token/i })).toBeTruthy();
    expect(screen.getByText(/phone app, desktop app, or script/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Software updates/i }));
    expect(await screen.findByRole("button", { name: /Check for updates/i })).toBeTruthy();
  });

  it("hides admin-only categories from a member", async () => {
    stubFetch("user");
    renderPage();
    await screen.findByText("max");
    expect(screen.getByText(/Some settings are only for admins/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Software updates/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Home network/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cloud backup/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remote access/i })).toBeNull();
  });
});

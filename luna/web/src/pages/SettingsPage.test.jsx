import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import SettingsPage from "./SettingsPage";

function stubFetch(role = "admin", connectActive = false) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me")) {
      return new Response(JSON.stringify({ id: "1", username: "max", role }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/auth/status")) {
      return new Response(JSON.stringify({ has_admin: role === "admin", connect_active: connectActive }), {
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
    if (u.includes("/network/status")) {
      return new Response(JSON.stringify({
        ethernet_connected: true,
        wifi_connected: false,
        has_default_route: true,
        ipv4: ["192.168.1.20"],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }));
}

function renderPage(initialPath = "/settings") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
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
        get length() { return store.size; },
        key: (index) => [...store.keys()][index] ?? null,
      };
    }
  });

  it("uses a category sidebar and opens Appearance by default", async () => {
    stubFetch("admin");
    renderPage();

    expect(await screen.findByRole("navigation", { name: /Settings categories/i })).toBeTruthy();
    expect(await screen.findByText("max")).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /System/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Light$/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Dark$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /If you forget your password/i })).toBeNull();
    expect(screen.queryByText(/Plug a USB keyboard into Luna/i )).toBeNull();
    expect(screen.queryByText(/Keep this card somewhere safe/i)).toBeNull();
  });

  it("keeps security and about in their own categories", async () => {
    stubFetch("admin");
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("max");

    await user.click(screen.getByRole("button", { name: /^Security$/i }));
    expect(await screen.findByRole("button", { name: /Sign out every browser/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revoke app access/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Create access token/i })).toBeTruthy();
    expect(screen.getByText(/phone app, Luna Desktop, or script/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^About$/i }));
    expect(await screen.findByRole("button", { name: /Check for updates/i })).toBeTruthy();
    expect(screen.getByText(/Luna only installs updates when you tell it to/i)).toBeTruthy();
  });

  it("splits Devices into Mobile App and Luna Desktop cards", async () => {
    stubFetch("admin");
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("max");

    await user.click(screen.getByRole("button", { name: /^Devices$/i }));
    expect(await screen.findByRole("heading", { level: 1, name: "Devices" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Mobile App" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Luna Desktop" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Desktop App" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Devices" })).toBeNull();
    expect(
      screen.getByText("Back up your photos from your phone onto your Luna."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Backup folders onto your Luna and access your Luna's files directly from your computer\. On Linux, the same download also works on Linux phones\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/copies new photos from the phone/i)).toBeNull();
    expect(screen.queryByText(/no iPhone app yet/i)).toBeNull();
    expect(screen.getByRole("link", { name: /Download the Luna app for Android/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Download Luna for Linux/i })).toBeTruthy();
    const tokenLinks = screen.getAllByRole("link", { name: /Create an access token in Security/i });
    expect(tokenLinks).toHaveLength(2);
    expect(tokenLinks[0]).toHaveAttribute("href", "/settings#security");
  });

  it("opens Security from a /settings#security location", async () => {
    stubFetch("admin");
    renderPage("/settings#security");

    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create access token/i })).toBeTruthy();
    expect(screen.getByText(/phone app, Luna Desktop, or script/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Devices" })).toBeNull();
  });

  it("switches to Security when the Devices access-token link is clicked", async () => {
    stubFetch("admin");
    const user = userEvent.setup();
    renderPage("/settings#devices");

    expect(await screen.findByRole("heading", { level: 1, name: "Devices" })).toBeTruthy();
    const tokenLinks = screen.getAllByRole("link", { name: /Create an access token in Security/i });
    await user.click(tokenLinks[0]);

    expect(await screen.findByRole("heading", { level: 1, name: "Security" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create access token/i })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Devices" })).toBeNull();
  });

  it("hides admin-only categories from a member", async () => {
    stubFetch("user");
    renderPage();
    await screen.findByText("max");
    expect(screen.getByText(/Some settings require an administrator/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^About$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /External Services/i })).toBeNull();
  });

  it("does not offer a Local Network category", async () => {
    stubFetch("admin");
    renderPage();
    await screen.findByText("max");
    expect(screen.queryByRole("button", { name: /Local Network/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^About$/i })).toBeTruthy();
  });

  it("hides External Services when Luna Connect is inactive on the device", async () => {
    stubFetch("admin", false);
    renderPage();
    await screen.findByText("max");
    expect(screen.queryByRole("button", { name: /External Services/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^About$/i })).toBeTruthy();
  });
});

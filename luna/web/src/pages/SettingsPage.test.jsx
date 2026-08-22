import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import SettingsPage, { RECOVERY_CARD } from "./SettingsPage";

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
  it("prints the keyboard recovery card in plain language", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/auth/me")) return new Response(JSON.stringify({ id: "1", username: "max", role: "admin" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/api/v1/setup")) return new Response(JSON.stringify({ name: "Luna", setup_completed: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/system/updates")) return new Response(JSON.stringify({ current_version: "0.1.0", latest_version: "luna-v0.1.0", update_available: false }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/device-tokens")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/connect/status")) return new Response(JSON.stringify({ enabled: false, backup_unlocked: false, backup_sources: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.endsWith("/api/v1/drives")) return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/network/")) return new Response(JSON.stringify({ connected: false, available: true, ethernet_connected: true, wifi_connected: false }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 404 });
    }));
    renderPage();
    expect(await screen.findByRole("heading", { name: RECOVERY_CARD.title })).toBeTruthy();
    expect(screen.getByText(/Plug a USB keyboard into Luna/i)).toBeTruthy();
    expect(screen.getByText(/Press Esc, then type luna, then press Enter/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check for updates/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sign out every browser/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop apps and helper tools/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create access token/i })).toBeTruthy();
    expect(screen.getByText(/computer or phone app, or a tool a helper set up/i)).toBeTruthy();
  });
});

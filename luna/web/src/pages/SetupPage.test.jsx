import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SetupPage from "./SetupPage";
import { AuthProvider } from "../context/AuthContext";

describe("SetupPage", () => {
  it("opens on welcome and shows the four discovery paths", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/setup")) return new Response(JSON.stringify({ name: "Luna", setup_completed: false }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/network/status")) return new Response(JSON.stringify({ ethernet_connected: false, wifi_interface: null, wifi_connected: false, has_default_route: false, interfaces: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.includes("/network/wifi")) return new Response(JSON.stringify({ available: false, connected: false }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response("{}", { status: 404 });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/setup"]}>
          <AuthProvider>
            <SetupPage />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getAllByText(/luna.local/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/169.254.42.42/i).length).toBeGreaterThan(0);
  });
});

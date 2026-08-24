import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SetupPage from "./SetupPage";
import { AuthProvider } from "../context/AuthContext";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me")) return jsonResponse({}, 401);
    if (u.includes("/auth/status")) return jsonResponse({ has_admin: false });
    if (u.includes("/api/v1/setup")) return jsonResponse({ name: "Luna", setup_completed: false });
    if (u.includes("/network/wifi/scan")) return jsonResponse([]);
    if (u.includes("/network/wifi")) return jsonResponse({ available: true, connected: false, ssid: null, ip_address: null, state: "disconnected" });
    if (u.includes("/network/status")) return jsonResponse({ ethernet_connected: false, wifi_interface: null, wifi_connected: false, has_default_route: false, interfaces: [] });
    return jsonResponse({ error: "not found" }, 404);
  });
}

function renderSetup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/setup"]}>
        <AuthProvider>
          <SetupPage />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("SetupPage", () => {
  it("opens on welcome with the logo, tagline, discovery paths, and begin button", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderSetup();
    expect(await screen.findByRole("heading", { name: "Luna" })).toBeTruthy();
    expect(screen.getByText(/Your files, your drives, your house/i)).toBeTruthy();
    expect(screen.getByText("luna.local")).toBeTruthy();
    expect(screen.queryByText("http://luna")).toBeNull();
    expect(screen.queryByText("http://169.254.42.42")).toBeNull();
    expect(screen.queryByText(/Luna Setup/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Begin Setup/i })).toBeTruthy();
  });

  it("advances to the Get online step when Begin Setup is clicked", async () => {
    vi.stubGlobal("fetch", stubFetch());
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin Setup/i }));
    expect(await screen.findByRole("heading", { name: /Plug in the cable/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Cable")).toBeTruthy());
  });
});

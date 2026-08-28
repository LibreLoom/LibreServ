import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SetupPage from "./SetupPage";
import { AuthProvider } from "../context/AuthContext";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch({
  network = {},
  setup = { name: "Luna", setup_completed: false, current_step: "welcome", step_data: {} },
  hasAdmin = false,
} = {}) {
  return vi.fn(async (url, init) => {
    const u = String(url);
    const method = (init?.method || "GET").toUpperCase();
    if (u.includes("/auth/me")) return jsonResponse({}, 401);
    if (u.includes("/auth/status")) return jsonResponse({ has_admin: hasAdmin });
    if (u.includes("/api/v1/setup") && method === "POST") {
      const body = init?.body ? JSON.parse(init.body) : {};
      return jsonResponse({
        name: body.name || setup.name || "Luna",
        setup_completed: body.setup_completed ?? setup.setup_completed ?? false,
        current_step: body.current_step || setup.current_step || "welcome",
        step_data: body.step_data || setup.step_data || {},
      });
    }
    if (u.includes("/api/v1/setup")) return jsonResponse(setup);
    if (u.includes("/network/wifi/scan")) return jsonResponse([]);
    if (u.includes("/network/wifi")) {
      return jsonResponse({ available: true, connected: false, ssid: null, ip_address: null, state: "disconnected" });
    }
    if (u.includes("/network/status")) {
      return jsonResponse({
        ethernet_connected: false,
        wifi_interface: null,
        wifi_connected: false,
        has_default_route: false,
        interfaces: [],
        ipv4: [],
        ...network,
      });
    }
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
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens on welcome with the logo, tagline, discovery paths, and begin button", async () => {
    vi.stubGlobal("fetch", stubFetch({ network: { ipv4: ["192.168.1.20"] } }));
    renderSetup();
    expect(await screen.findByRole("heading", { name: "Luna" })).toBeTruthy();
    expect(screen.getByText(/Your files, your drives, your house/i)).toBeTruthy();
    expect(screen.getByText("luna.local")).toBeTruthy();
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.getByText(/current address on the screen/i)).toBeTruthy();
    expect(screen.queryByText("http://luna")).toBeNull();
    expect(screen.queryByText("http://169.254.42.42")).toBeNull();
    expect(screen.queryByText(/Luna Setup/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Begin Setup/i })).toBeTruthy();
  });

  it("advances to the Get online step when Begin Setup is clicked", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin Setup/i }));
    expect(await screen.findByRole("heading", { name: /Connect Ethernet/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Ethernet")).toBeTruthy());
    await waitFor(() => {
      const progressPosts = fetchMock.mock.calls.filter(([url, init]) => {
        return String(url).includes("/api/v1/setup") && (init?.method || "GET").toUpperCase() === "POST";
      });
      expect(progressPosts.length).toBeGreaterThan(0);
      const body = JSON.parse(progressPosts[0][1].body);
      expect(body.current_step).toBe("network");
    });
  });

  it("shows Continue without Luna Connect code on the cable step when online", async () => {
    vi.stubGlobal("fetch", stubFetch({ network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] } }));
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin Setup/i }));
    expect(await screen.findByRole("button", { name: /Continue/i })).toBeTruthy();
    expect(screen.queryByText(/Code from the Luna Connect site/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Save code/i })).toBeNull();
  });

  it("resumes at the saved setup step on load", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        setup: {
          name: "Luna",
          setup_completed: false,
          current_step: "account",
          step_data: { network_connected: true },
        },
      }),
    );
    renderSetup();
    expect(await screen.findByRole("heading", { name: /Create your account/i })).toBeTruthy();
  });

  it("asks for the Luna Connect setup code on a public hostname", async () => {
    vi.stubGlobal("fetch", stubFetch({ network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] } }));
    vi.stubGlobal("location", { ...window.location, hostname: "photos.luna.servers.libreloom.org" });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin Setup/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue/i }));
    expect(await screen.findByLabelText(/One-time setup code/i)).toBeTruthy();
    expect(screen.getByText(/nobody else on the internet/i)).toBeTruthy();
  });
});

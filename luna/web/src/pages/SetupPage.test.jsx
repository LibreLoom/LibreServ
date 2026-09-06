import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SetupPage from "./SetupPage";
import { AuthProvider } from "../context/AuthContext";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function healthyPreflight() {
  return {
    healthy: true,
    checks: {
      database: { status: "ok", category: "system" },
      database_writable: { status: "ok", category: "storage" },
      data_path_writable: { status: "ok", category: "storage" },
      logs_path_writable: { status: "ok", category: "storage" },
      disk_space: { status: "ok", category: "system", disk_space_bytes_free: 8_000_000_000 },
      api_server: { status: "ok", category: "system" },
    },
  };
}

function stubFetch({
  network = {},
  setup = { name: "Luna", setup_completed: false, current_step: "welcome", step_data: {} },
  hasAdmin = false,
  connectActive = false,
  connect = /** @type {Record<string, unknown>} */ ({}),
  me = null,
} = {}) {
  return vi.fn(async (url, init) => {
    const u = String(url);
    const method = (init?.method || "GET").toUpperCase();
    if (u.includes("/auth/me")) {
      if (me) return jsonResponse(me);
      return jsonResponse({}, 401);
    }
    if (u.includes("/auth/status")) {
      return jsonResponse({ has_admin: hasAdmin, connect_active: connectActive });
    }
    if (u.includes("/api/v1/connect/status")) {
      return jsonResponse({
        connect_active: connectActive,
        enabled: Boolean(connect.hostname || connect.domain),
        hostname: null,
        domain: null,
        ...connect,
      });
    }
    if (u.includes("/api/v1/setup/preflight")) return jsonResponse(healthyPreflight());
    if (u.includes("/api/v1/setup/fetch-mag") && method === "POST") {
      return jsonResponse({ ok: false, source: "none", attempts: 0 });
    }
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

  it("opens on welcome with the logo, tagline, and begin button", async () => {
    vi.stubGlobal("fetch", stubFetch({ network: { ipv4: ["192.168.1.20"] } }));
    renderSetup();
    expect(await screen.findByRole("heading", { name: "Welcome." })).toBeTruthy();
    expect(screen.getByText(/get Luna set up for you/i)).toBeTruthy();
    expect(screen.queryByText("luna.local")).toBeNull();
    expect(screen.queryByText("192.168.1.20")).toBeNull();
    expect(screen.queryByText(/On your home internet only/i)).toBeNull();
    expect(screen.queryByText(/Everywhere/i)).toBeNull();
    expect(screen.queryByText("http://luna")).toBeNull();
    expect(screen.queryByText("http://169.254.42.42")).toBeNull();
    expect(screen.queryByText(/Luna Setup/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Begin Setup/i })).toBeTruthy();
  });

  it("advances to system check then Create your account when Begin Setup is clicked", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin Setup/i }));
    expect(await screen.findByRole("heading", { name: /System check/i })).toBeTruthy();
    expect(screen.getByText(/2\s*\/\s*5/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    expect(await screen.findByRole("heading", { name: /Create your account/i })).toBeTruthy();
    expect(screen.getByText(/3\s*\/\s*5/)).toBeTruthy();
    await waitFor(() => {
      const progressPosts = fetchMock.mock.calls.filter(([url, init]) => {
        return String(url).includes("/api/v1/setup") && (init?.method || "GET").toUpperCase() === "POST";
      });
      const savePost = progressPosts.find(([, init]) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        return body.current_step === "account" && body.step_data?.preflight_passed === true;
      });
      expect(savePost).toBeTruthy();
    });
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
    expect(screen.getByText(/3\s*\/\s*5/)).toBeTruthy();
    expect(screen.getByLabelText(/What's your name/i)).toBeTruthy();
  });

  it("does not attach a substep slide/pop class to the name field on first account paint", async () => {
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
    const input = await screen.findByLabelText(/What's your name/i);
    // SetupCard may still slide the step; the field group inside the form must
    // not also play slide-in-from-*-pop on first paint (that double-pop jumped
    // when the name input was focused).
    const form = input.closest("form");
    expect(form).toBeTruthy();
    expect(form.querySelectorAll("[class*='slide-in-from']").length).toBe(0);
  });

  it("slides the username field in after continuing from the name substep", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    const username = await screen.findByLabelText(/Pick a username/i);
    const form = username.closest("form");
    expect(form.querySelector("[class*='slide-in-from']")).toBeTruthy();
  });

  it("drops SetupCard slide classes after the step entrance animation ends", async () => {
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
    await screen.findByRole("heading", { name: /Create your account/i });
    const slide = [...document.querySelectorAll('[data-slot="one-shot-slide"]')]
      .find((el) => el.className.includes("slide-in-from"));
    expect(slide).toBeTruthy();
    await waitFor(() => {
      expect(slide.className).not.toMatch(/slide-in-from/);
      expect(slide.className).not.toMatch(/animate-in/);
    });
  });

  it("drops account substep slide classes after the field entrance animation ends", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    const username = await screen.findByLabelText(/Pick a username/i);
    const form = username.closest("form");
    const slide = form.querySelector('[data-slot="one-shot-slide"]');
    expect(slide?.className).toMatch(/slide-in-from/);
    await waitFor(() => {
      expect(slide.className).not.toMatch(/slide-in-from/);
    });
  });

  it("asks for the Luna Connect setup code on a public hostname when Connect is active", async () => {
    vi.stubGlobal("fetch", stubFetch({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      connectActive: true,
    }));
    vi.stubGlobal("location", { ...window.location, hostname: "photos.luna.servers.libreloom.org" });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin Setup/i }));
    expect(await screen.findByRole("heading", { name: /System check/i })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    expect(await screen.findByRole("heading", { name: /Create your account/i })).toBeTruthy();
    expect(screen.getByText(/3\s*\/\s*5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Pick a username/i), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Choose a password/i), { target: { value: "SecurePass123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Confirm your password/i), { target: { value: "SecurePass123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    expect(await screen.findByLabelText(/Your device token/i)).toBeTruthy();
    expect(screen.getByText(/nobody else on the internet/i)).toBeTruthy();
  });

  it("skips Luna Connect setup code on a public hostname when Connect is inactive", async () => {
    vi.stubGlobal("fetch", stubFetch({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      connectActive: false,
    }));
    vi.stubGlobal("location", { ...window.location, hostname: "photos.luna.servers.libreloom.org" });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin Setup/i }));
    expect(await screen.findByRole("heading", { name: /System check/i })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    expect(await screen.findByRole("heading", { name: /Create your account/i })).toBeTruthy();
    expect(screen.getByText(/3\s*\/\s*5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Pick a username/i), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Choose a password/i), { target: { value: "SecurePass123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Confirm your password/i), { target: { value: "SecurePass123!" } });
    expect(screen.queryByLabelText(/Your device token/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Create account/i })).toBeTruthy();
  });
});

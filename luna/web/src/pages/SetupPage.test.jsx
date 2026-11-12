import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SetupPage from "./SetupPage";
import LoginPage from "./LoginPage";
import { AuthProvider } from "../context/AuthContext";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function healthyPreflight() {
  return {
    healthy: true,
    checks: {
      database: { status: "passed", category: "system" },
      data_path_writable: { status: "passed", category: "storage" },
      logs_path_writable: { status: "passed", category: "storage" },
      disk_space: {
        status: "passed",
        category: "system",
        details: { free_bytes: 8_000_000_000, free_human: "8.0 GB" },
      },
      clock: { status: "passed", category: "system" },
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
    if (u.includes("/auth/login") && method === "POST") {
      return jsonResponse({ id: "u1", username: "max", display_name: "Max", role: "admin" });
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

function renderSetup(initialEntry = "/setup") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <AuthProvider>
            <SetupPage />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderSetupWithLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/setup"]}>
        <ToastProvider>
          <AuthProvider>
            <Routes>
              <Route path="/setup" element={<SetupPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/" element={<div>Dashboard route</div>} />
            </Routes>
          </AuthProvider>
        </ToastProvider>
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
    expect(screen.queryByText(/On your home network only/i)).toBeNull();
    expect(screen.queryByText(/Everywhere/i)).toBeNull();
    expect(screen.queryByText("http://luna")).toBeNull();
    expect(screen.queryByText("http://169.254.42.42")).toBeNull();
    expect(screen.queryByText(/Luna Setup/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Begin setup/i })).toBeTruthy();
  });

  it("advances to system check then Create your account when Begin setup is clicked", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin setup/i }));
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
    const nameInput = screen.getByLabelText(/What's your name/i);
    expect(nameInput).toBeTruthy();
    expect(document.activeElement).toBe(nameInput);
  });

  it("backs from the first account field to the system check and keeps the entered name", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        setup: {
          name: "Luna",
          setup_completed: false,
          current_step: "account",
          step_data: { network_connected: true, preflight_passed: true },
        },
      }),
    );
    renderSetup();

    const nameInput = await screen.findByLabelText(/What's your name/i);
    fireEvent.change(nameInput, { target: { value: "Max's Luna" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: /System check/i })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));

    const resumedNameInput = await screen.findByLabelText(/What's your name/i);
    expect(resumedNameInput).toHaveValue("Max's Luna");
  });

  it("returns to unfinished setup after signing in to finish it", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        hasAdmin: true,
        setup: {
          name: "Luna",
          setup_completed: false,
          current_step: "name",
          step_data: { account_completed: true },
        },
      }),
    );
    renderSetupWithLogin();

    fireEvent.click(await screen.findByRole("link", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "max" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "task-owned-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    expect(await screen.findByRole("heading", { name: "Name your Luna" })).toBeTruthy();
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

  it("slides the username field in after continuing from the name substep and immediately focuses it", async () => {
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
    expect(document.activeElement).toBe(username);
    const form = username.closest("form");
    expect(form.querySelector("[class*='slide-in-from']")).toBeTruthy();
  });

  it("immediately sends focus to the Luna name input on the Name step", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        setup: {
          name: "Luna",
          setup_completed: false,
          current_step: "name",
          step_data: { network_connected: true, preflight_passed: true, account_completed: true },
        },
      }),
    );
    renderSetup();
    const nameInput = await screen.findByPlaceholderText("e.g. Family Luna");
    expect(document.activeElement).toBe(nameInput);
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

  it("shows username rules on the username step instead of waiting for Create account", async () => {
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
    fireEvent.change(username, { target: { value: "hello world" } });

    expect(
      await screen.findByText(/Usernames are 3-32 letters, numbers, dots, dashes, or underscores/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue/i })).toBeDisabled();
    expect(screen.queryByLabelText(/Choose a password/i)).toBeNull();

    fireEvent.change(username, { target: { value: "alex" } });
    expect(
      screen.queryByText(/Usernames are 3-32 letters, numbers, dots, dashes, or underscores/i),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Continue/i })).not.toBeDisabled();
  });

  it("blocks an overlong display name before the username step", async () => {
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
    const name = await screen.findByLabelText(/What's your name/i);
    fireEvent.change(name, { target: { value: "x".repeat(81) } });
    expect(await screen.findByText(/Names can be up to 80 characters/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue/i })).toBeDisabled();
  });

  it("hides the password policy hint once the strength checklist is visible", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
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
    fireEvent.click(await screen.findByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Pick a username/i), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

    const passwordInput = await screen.findByLabelText(/Choose a password/i);
    expect(passwordInput.getAttribute("placeholder")).toBe('Not "a1!", please.');
    expect(
      screen.getByText("At least 12 characters, with a letter and a number"),
    ).toBeTruthy();

    fireEvent.change(passwordInput, { target: { value: "abc" } });
    expect(
      screen.queryByText("At least 12 characters, with a letter and a number"),
    ).toBeNull();
    expect(screen.getByText("12+ chars")).toBeTruthy();
    expect(screen.getByText("Not strong enough yet")).toBeTruthy();
  });

  it("asks for the Luna Connect device token on a public hostname when Connect is active", async () => {
    vi.stubGlobal("fetch", stubFetch({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      connectActive: true,
    }));
    vi.stubGlobal("location", { ...window.location, hostname: "photos.luna.servers.libreloom.org" });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin setup/i }));
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

  it("says the account was created when automatic sign-in fails afterward", async () => {
    const fallback = stubFetch();
    const fetchMock = vi.fn((url, init) => {
      const path = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (path.includes("/auth/register") && method === "POST") {
        return Promise.resolve(jsonResponse({ id: "u1", username: "alex", role: "admin" }));
      }
      if (path.includes("/auth/login") && method === "POST") {
        return Promise.resolve(jsonResponse({ error: "Luna is busy." }, 503));
      }
      return fallback(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();

    fireEvent.click(await screen.findByRole("button", { name: /Begin setup/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    fireEvent.change(await screen.findByLabelText(/Pick a username/i), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(await screen.findByLabelText(/Choose a password/i), { target: { value: "SecurePass123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(await screen.findByLabelText(/Confirm your password/i), { target: { value: "SecurePass123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/i }));

    expect(await screen.findByText(/Your account was created, but Luna couldn't sign you in/i)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Try signing in" });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    const registration = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/auth/register") && init?.method === "POST");
    expect(JSON.parse(registration[1].body)).toMatchObject({ username: "alex", password: "SecurePass123!" });

    fireEvent.click(retry);
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/auth/register") && init?.method === "POST")).toHaveLength(1);
      expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/auth/login") && init?.method === "POST")).toHaveLength(2);
    });
  });

  it("skips Luna Connect device token on a public hostname when Connect is inactive", async () => {
    vi.stubGlobal("fetch", stubFetch({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      connectActive: false,
    }));
    vi.stubGlobal("location", { ...window.location, hostname: "photos.luna.servers.libreloom.org" });
    renderSetup();
    fireEvent.click(await screen.findByRole("button", { name: /Begin setup/i }));
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

  it("consumes ?token= to skip the device-token step and still registers with that secret", async () => {
    let registered = false;
    const baseOpts = {
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      connectActive: true,
    };
    const fetchMock = vi.fn(async (url, init) => {
      const u = String(url);
      const method = (init?.method || "GET").toUpperCase();
      if (u.includes("/auth/register") && method === "POST") {
        registered = true;
        return jsonResponse({
          id: "u1",
          username: "alex",
          display_name: "Alex",
          role: "admin",
        });
      }
      if (u.includes("/auth/login") && method === "POST") {
        return jsonResponse({
          id: "u1",
          username: "alex",
          display_name: "Alex",
          role: "admin",
        });
      }
      return stubFetch({
        ...baseOpts,
        hasAdmin: registered,
        me: registered
          ? { id: "u1", username: "alex", display_name: "Alex", role: "admin" }
          : null,
      })(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, hostname: "photos.luna.servers.libreloom.org" });

    renderSetup("/setup?token=ABCD-EFGH-IJKM-NPQR-STUV");
    fireEvent.click(await screen.findByRole("button", { name: /Begin setup/i }));
    expect(await screen.findByRole("heading", { name: /System check/i })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    expect(await screen.findByRole("heading", { name: /Create your account/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Pick a username/i), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Choose a password/i), { target: { value: "SecurePass123!" } });
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByLabelText(/Confirm your password/i), { target: { value: "SecurePass123!" } });

    expect(screen.queryByLabelText(/Your device token/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Create account/i })).toBeTruthy();
    expect(screen.getByText(/4\s*of\s*4/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Create account/i }));

    await waitFor(() => {
      const registerCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes("/auth/register") && (init?.method || "GET").toUpperCase() === "POST",
      );
      expect(registerCall).toBeTruthy();
      const body = JSON.parse(registerCall[1].body);
      expect(body.setup_secret).toBe("ABCD-EFGH-IJKM-NPQR-STUV");
    });
  });

  describe("no recovery phrase step", () => {
    const ADMIN = { id: "1", username: "admin", display_name: "Admin", role: "admin" };
    const accountDone = {
      name: "Luna",
      setup_completed: false,
      current_step: "account",
      step_data: { network_connected: true, preflight_passed: true, account_completed: true },
    };

    it("goes from Account straight to Name, counting 4 / 5", async () => {
      vi.stubGlobal("fetch", stubFetch({ setup: accountDone, hasAdmin: true, me: { ...ADMIN, phrase_set: false } }));
      renderSetup();
      expect(await screen.findByPlaceholderText("e.g. Family Luna")).toBeTruthy();
      expect(screen.getByText(/4\s*\/\s*5/)).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Write down your recovery phrase" })).toBeNull();
    });

    it("finishes setup without ever asking for a phrase", async () => {
      const fetchMock = stubFetch({ setup: { ...accountDone, current_step: "name" }, hasAdmin: true, me: { ...ADMIN, phrase_set: false } });
      vi.stubGlobal("fetch", fetchMock);
      renderSetup();
      await screen.findByPlaceholderText("e.g. Family Luna");
      fireEvent.click(await screen.findByRole("button", { name: /Finish setup/i }));
      expect(await screen.findByRole("button", { name: /Go to dashboard/i })).toBeTruthy();
      const paths = fetchMock.mock.calls.map(([url]) => String(url));
      expect(paths.some((u) => u.includes("/cloud/identity") || u.includes("/cloud/phrase"))).toBe(false);
    });

    it("resuming on the dropped phrase step lands on Name", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch({ setup: { ...accountDone, current_step: "phrase" }, hasAdmin: true, me: { ...ADMIN, phrase_set: false } }),
      );
      renderSetup();
      expect(await screen.findByPlaceholderText("e.g. Family Luna")).toBeTruthy();
    });

    it("signed out on the naming step shows the account sign-in", async () => {
      vi.stubGlobal("fetch", stubFetch({ setup: { ...accountDone, current_step: "name" }, hasAdmin: true }));
      renderSetup();
      expect(await screen.findByRole("heading", { name: /Sign in to continue/i })).toBeTruthy();
    });
  });

  it("automatically focuses the Go to dashboard button on the Done step", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        setup: {
          name: "Luna Box",
          setup_completed: false,
          current_step: "name",
          step_data: { account_completed: true },
        },
        hasAdmin: true,
        me: { id: "1", username: "admin", display_name: "Admin", role: "admin" },
      }),
    );

    renderSetup();

    const finishButton = await screen.findByRole("button", { name: /Finish setup/i });
    fireEvent.click(finishButton);

    const goDashboardButton = await screen.findByRole("button", { name: /Go to dashboard/i });
    expect(goDashboardButton).toBeTruthy();

    await waitFor(() => {
      expect(document.activeElement).toBe(goDashboardButton);
    });
  });
});

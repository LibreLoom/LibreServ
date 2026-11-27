import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import SetupPage from "./SetupPage";
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
  offLan = false,
  deviceTokenSet = undefined,
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
      return jsonResponse({ has_admin: hasAdmin, connect_active: connectActive, setup_off_lan: offLan, device_token_set: deviceTokenSet });
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

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="setup-location">{location.pathname}{location.search}{location.hash}</output>;
}

function renderSetup(initialEntry = "/setup", { probeLocation = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <AuthProvider>
            <SetupPage />
            {probeLocation ? <LocationProbe /> : null}
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Walks the account step; returns the device token field when it is asked for. */
async function openDeviceTokenField({ prefilled = false, asked = true } = {}) {
  fireEvent.click(await screen.findByRole("button", { name: /Begin setup/i }));
  await screen.findByRole("heading", { name: /System check/i });
  // The check runs in the background; Continue appears when it finishes.
  fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
  await screen.findByRole("heading", { name: /Create your account/i });
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
  fireEvent.change(screen.getByLabelText(/Pick a username/i), { target: { value: "alex" } });
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
  fireEvent.change(screen.getByLabelText(/Choose a password/i), { target: { value: "SecurePass123!" } });
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
  fireEvent.change(screen.getByLabelText(/Confirm your password/i), { target: { value: "SecurePass123!" } });
  if (prefilled || !asked) return null;
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
  return screen.findByLabelText(/^Device token/i);
}

/** Registration succeeds and records the exact body the page submitted. */
function stubRegistration(options = {}) {
  const state = { body: null };
  const account = { id: "u1", username: "alex", display_name: "Alex", role: "admin" };
  const fetchMock = vi.fn(async (url, init) => {
    const u = String(url);
    const method = (init?.method || "GET").toUpperCase();
    if (u.includes("/auth/register") && method === "POST") {
      state.body = JSON.parse(init.body);
      return jsonResponse(account);
    }
    if (u.includes("/auth/login") && method === "POST") return jsonResponse(account);
    return stubFetch({
      ...options,
      hasAdmin: Boolean(state.body),
      me: state.body ? account : null,
    })(url, init);
  });
  return { fetchMock, state };
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

  it("asks for the device token when Luna says setup is off the home network", async () => {
    vi.stubGlobal("fetch", stubFetch({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      offLan: true,
    }));
    renderSetup();

    const token = await openDeviceTokenField();
    expect(token).toHaveValue("");
    expect(screen.getByText(/quick-start guide/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create account/i })).toBeDisabled();
    expect(screen.queryByLabelText(/setup key/i)).toBeNull();
  });

  it("says setup needs the home network when Luna has no device token", async () => {
    vi.stubGlobal("fetch", stubFetch({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      offLan: true,
      deviceTokenSet: false,
    }));
    renderSetup();

    await openDeviceTokenField({ asked: false });
    expect(screen.getByText("This Luna has no device token. Set it up from the same network as Luna.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Device token/i)).toBeNull();
  });

  it("never asks for a device token on the home network", async () => {
    const { fetchMock, state } = stubRegistration({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      offLan: false,
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, hostname: "luna.local", pathname: "/setup" });
    renderSetup();

    await openDeviceTokenField({ asked: false });
    expect(screen.queryByLabelText(/^Device token/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Create account/i }));

    await waitFor(() => expect(state.body).not.toBeNull());
    expect(state.body).not.toHaveProperty("device_token");
  });

  it("submits the typed device token ungrouped as device_token", async () => {
    const { fetchMock, state } = stubRegistration({
      network: { ethernet_connected: true, has_default_route: true },
      offLan: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSetup();

    const token = await openDeviceTokenField();
    fireEvent.change(token, { target: { value: "7k4m-2q9x-r8n3-6t5w-1pzh" } });
    fireEvent.click(screen.getByRole("button", { name: /Create account/i }));

    await waitFor(() => expect(state.body).not.toBeNull());
    expect(state.body.device_token).toBe("7K4M2Q9XR8N36T5W1PZH");
  });

  it("consumes the token fragment, removes it from the URL, and submits it", async () => {
    const { fetchMock, state } = stubRegistration({
      network: { ethernet_connected: true, has_default_route: true, ipv4: ["192.168.1.8"] },
      offLan: true,
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSetup("/setup?keep=1#token=7K4M-2Q9X-R8N3-6T5W-1PZH", { probeLocation: true });
    await waitFor(() => expect(screen.getByTestId("setup-location")).toHaveTextContent("/setup?keep=1"));
    expect(screen.getByTestId("setup-location")).not.toHaveTextContent("7K4M");
    await openDeviceTokenField({ prefilled: true });

    expect(screen.queryByLabelText(/^Device token/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Create account/i })).toBeTruthy();
    expect(screen.getByText(/4\s*of\s*4/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Create account/i }));

    await waitFor(() => expect(state.body).not.toBeNull());
    expect(state.body.device_token).toBe("7K4M2Q9XR8N36T5W1PZH");
  });

  it("strips ?token= without accepting it", async () => {
    const { fetchMock } = stubRegistration({
      network: { ethernet_connected: true, has_default_route: true },
      offLan: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSetup("/setup?token=QUERY-TOKEN&keep=1", { probeLocation: true });

    await waitFor(() => expect(screen.getByTestId("setup-location")).toHaveTextContent("/setup?keep=1"));
    expect(screen.getByTestId("setup-location")).not.toHaveTextContent("QUERY-TOKEN");
    const token = await openDeviceTokenField();
    expect(token).toHaveValue("");
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

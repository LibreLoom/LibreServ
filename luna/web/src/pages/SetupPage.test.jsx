import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import SetupPage from "./SetupPage";
import { AuthProvider } from "../context/AuthContext";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { toBase64 } from "../lib/cloudPhrase";

const SIGNING_PUBLIC = toBase64(new Uint8Array(SIG_PUBLIC_LEN).map((_, i) => (i + 5) % 256));

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
  finishRefusal = null,
  identityFails = false,
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
    if (u.includes("/api/v1/cloud/identity") && method === "POST") {
      if (identityFails) return jsonResponse({ error: "Luna could not make its keys." }, 409);
      return jsonResponse({ luna_id: "luna-1", signing_public: SIGNING_PUBLIC });
    }
    if (u.includes("/api/v1/cloud/phrase") && method === "PUT") return jsonResponse({ set: true, set_at: 1 });
    if (u.includes("/api/v1/setup/preflight")) return jsonResponse(healthyPreflight());
    if (u.includes("/api/v1/setup/fetch-mag") && method === "POST") {
      return jsonResponse({ ok: false, source: "none", attempts: 0 });
    }
    if (u.includes("/api/v1/setup") && method === "POST") {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (finishRefusal && body.setup_completed) return jsonResponse(finishRefusal.body, finishRefusal.status);
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
    expect(screen.getByText(/2\s*\/\s*6/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/i }));
    expect(await screen.findByRole("heading", { name: /Create your account/i })).toBeTruthy();
    expect(screen.getByText(/3\s*\/\s*6/)).toBeTruthy();
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
    expect(screen.getByText(/3\s*\/\s*6/)).toBeTruthy();
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
    expect(screen.getByText(/3\s*\/\s*6/)).toBeTruthy();
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

  describe("recovery phrase step", () => {
    const ADMIN = { id: "1", username: "admin", display_name: "Admin", role: "admin" };
    const accountDone = {
      name: "Luna",
      setup_completed: false,
      current_step: "account",
      step_data: { network_connected: true, preflight_passed: true, account_completed: true },
    };

    async function typeConfirmWords() {
      const words = within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.textContent.trim().replace(/^\d+\.\s*/, ""));
      fireEvent.click(screen.getByRole("button", { name: "I wrote it down" }));
      for (const input of screen.getAllByRole("textbox")) {
        const n = Number(input.getAttribute("aria-label").replace("Word ", ""));
        fireEvent.change(input, { target: { value: words[n - 1] } });
      }
    }

    it("comes after Account and before Name, and counts 4 / 6", async () => {
      vi.stubGlobal("fetch", stubFetch({ setup: accountDone, hasAdmin: true, me: { ...ADMIN, phrase_set: false } }));
      renderSetup();
      expect(await screen.findByRole("heading", { name: "Write down your recovery phrase" })).toBeTruthy();
      expect(screen.getByText(/4\s*\/\s*6/)).toBeTruthy();
      expect(screen.queryByPlaceholderText("e.g. Family Luna")).toBeNull();
    });

    it("moves to Name after the phrase is saved, saving only phrase_set: true", async () => {
      const fetchMock = stubFetch({ setup: accountDone, hasAdmin: true, me: { ...ADMIN, phrase_set: false } });
      vi.stubGlobal("fetch", fetchMock);
      renderSetup();
      await screen.findByRole("heading", { name: "Write down your recovery phrase" });
      await typeConfirmWords();
      fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
      expect(await screen.findByPlaceholderText("e.g. Family Luna")).toBeTruthy();
      expect(screen.getByText(/5\s*\/\s*6/)).toBeTruthy();
      const saved = fetchMock.mock.calls
        .filter(([url, init]) => String(url).endsWith("/api/v1/setup") && (init?.method || "GET") === "POST")
        .map(([, init]) => JSON.parse(init.body));
      expect(saved.some((b) => b.current_step === "name" && b.step_data?.phrase_set === true)).toBe(true);
      expect(JSON.stringify(saved)).not.toMatch(/seal_public|self_sealed/);
    });

    it("resuming on the phrase step with a phrase already saved lands on Name", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch({ setup: { ...accountDone, current_step: "phrase" }, hasAdmin: true, me: { ...ADMIN, phrase_set: true } }),
      );
      renderSetup();
      expect(await screen.findByPlaceholderText("e.g. Family Luna")).toBeTruthy();
    });

    it("resuming on Name without a saved phrase goes back to the phrase step", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch({ setup: { ...accountDone, current_step: "name" }, hasAdmin: true, me: { ...ADMIN, phrase_set: false } }),
      );
      renderSetup();
      expect(await screen.findByRole("heading", { name: "Write down your recovery phrase" })).toBeTruthy();
    });

    it("signed out on the phrase step shows the account sign-in", async () => {
      vi.stubGlobal("fetch", stubFetch({ setup: { ...accountDone, current_step: "phrase" }, hasAdmin: true }));
      renderSetup();
      expect(await screen.findByRole("heading", { name: /Sign in to continue/i })).toBeTruthy();
    });

    it("shows Luna's message and Try again when the keys can't be made", async () => {
      vi.stubGlobal("fetch", stubFetch({ setup: accountDone, hasAdmin: true, me: { ...ADMIN, phrase_set: false }, identityFails: true }));
      renderSetup();
      expect(await screen.findByText("Luna could not make its keys.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });

    it("sends the person back to the phrase step when Luna refuses to finish without one", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch({
          setup: { ...accountDone, current_step: "name" },
          hasAdmin: true,
          me: ADMIN,
          finishRefusal: {
            status: 409,
            body: { error: "Set up your recovery phrase before you finish setup.", code: "needs_phrase" },
          },
        }),
      );
      renderSetup();
      fireEvent.click(await screen.findByRole("button", { name: /Finish setup/i }));
      expect(await screen.findByRole("heading", { name: "Write down your recovery phrase" })).toBeTruthy();
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

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../../context/AuthContext";
import AboutCategory from "./AboutCategory";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

const SHIPPED_KEY = "RWBUILTIN";
const FEED_URL = "https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds";
const SOURCE_RESPONSE = {
  feed_url: FEED_URL,
  channel: "stable",
  keys: [],
  effective_keys: [SHIPPED_KEY],
  default_keys: true,
  defaults: {
    feed_url: FEED_URL,
    channel: "stable",
    keys: [SHIPPED_KEY],
  },
};

function stubFetch(sourceBody) {
  return vi.fn(async (path, options) => {
    void options;
    const u = String(path);
    if (u.includes("/auth/me")) {
      return new Response(JSON.stringify({ id: "1", username: "max", role: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/auth/status")) {
      return new Response(JSON.stringify({ has_admin: true, connect_active: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path.startsWith("/api/v1/health")) {
      return new Response(JSON.stringify({ status: "ok", product: "Luna", version: "0.1.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path.startsWith("/api/v1/setup")) {
      return new Response(JSON.stringify({ name: "Living Room Luna", setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path.startsWith("/api/v1/network/status")) {
      return new Response(
        JSON.stringify({
          ethernet_connected: true,
          has_default_route: true,
          ipv4: ["192.168.1.20"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (path.startsWith("/api/v1/connect/status")) {
      return new Response(JSON.stringify({ enabled: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (path.startsWith("/api/v1/system/health/check")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          summary: { total_checks: 1, passed: 1, warnings: 0, failed: 0 },
          checks: { database: { status: "passed", message: "ok", category: "system" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (path.startsWith("/api/v1/system/updates/source")) {
      return new Response(JSON.stringify(sourceBody ?? SOURCE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        current_version: "0.1.0",
        latest_version: "0.1.0",
        update_available: false,
        release_notes: "",
        checksum: "",
        binary_name: "lunad-linux-amd64",
        reboot_required: false,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

async function openAdvanced(user) {
  await user.click(await screen.findByRole("button", { name: /^Update source$/i }));
  await user.click(await screen.findByRole("button", { name: /Feed address and signing keys/i }));
}

async function openEditor(user) {
  await openAdvanced(user);
  await user.click(await screen.findByRole("button", { name: /Edit update source/i }));
}

function renderPage(fetchImpl) {
  vi.stubGlobal("fetch", fetchImpl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
    <MemoryRouter initialEntries={["/settings?cat=about"]}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AboutCategory />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
    </ToastProvider>,
  );
}

describe("AboutCategory", () => {
  it("shows Luna branding, device info, access addresses, and the update card", async () => {
    renderPage(stubFetch());
    expect(await screen.findByText(/home file box/i)).toBeTruthy();
    const deviceRow = await screen.findByText("This Luna");
    expect(deviceRow.closest("[data-slot='value-display']")).toBeTruthy();
    const deviceValue = screen.getByText("Living Room Luna");
    expect(deviceValue.className).toMatch(/rounded-pill/);
    expect(screen.queryByText("Software")).toBeNull();
    expect(await screen.findByRole("heading", { name: "Where to open Luna" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Everywhere" })).toBeNull();
    expect(screen.getByRole("heading", { name: "On your local network" })).toBeTruthy();
    expect(await screen.findByDisplayValue("http://luna.local")).toBeTruthy();
    expect(await screen.findByDisplayValue("http://192.168.1.20")).toBeTruthy();
    expect(screen.queryByText(/None yet/i)).toBeNull();
    expect(screen.queryByText(/Waiting for an address/i)).toBeNull();
    expect(await screen.findByRole("heading", { name: "System updates" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Check for updates/i })).toBeTruthy();
    expect(screen.getByText("Default source")).toBeTruthy();
    expect(screen.getByText(FEED_URL)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "System checks" })).toBeTruthy();
  });

  it("orders the About page: updates, support, addresses, advanced, checks, then Luna", async () => {
    renderPage(stubFetch());
    await screen.findByRole("heading", { name: "System checks" });
    const about = document.querySelector("[data-slot='about-category']");
    expect(about).toBeTruthy();
    const headings = Array.from(about.querySelectorAll("h2")).map((el) => el.textContent);
    const idx = (re) => headings.findIndex((t) => re.test(t));
    const order = [
      /System updates/i,
      /Support Luna/i,
      /Where to open Luna/i,
      /Advanced/i,
      /System checks/i,
      /^Luna$/i,
    ];
    for (const re of order) expect(idx(re)).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) {
      expect(idx(order[i])).toBeGreaterThan(idx(order[i - 1]));
    }
  });

  it("lists open source licenses in a collapsible section and opens each in a modal", async () => {
    const user = userEvent.setup();
    const baseFetch = stubFetch();
    const fetchImpl = vi.fn(async (path, options) => {
      if (String(path).startsWith("/licenses/")) {
        return new Response("GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3 test text", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return baseFetch(path, options);
    });
    renderPage(fetchImpl);
    await screen.findByRole("heading", { name: "System checks" });

    const toggle = screen.getByRole("button", { name: /Open source licenses/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("EuroOffice")).toBeTruthy();
    expect(screen.getByText("x2t.wasm")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Open x2t\.wasm license/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByText(/Version 3 test text/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /onlyoffice-x2t-wasm/i })).toHaveAttribute(
      "href",
      "https://github.com/cryptpad/onlyoffice-x2t-wasm",
    );
  });

  it("keeps Luna Connect closed and opens a device-token modal from Advanced", async () => {
    const user = userEvent.setup();
    renderPage(stubFetch());
    await screen.findByText("Default source");

    expect(screen.getByText("Set or remove the Luna Connect device token here.")).toBeTruthy();
    expect(screen.queryByLabelText("Device token from Luna Connect")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save device token/i })).toBeNull();

    const lunaConnectToggle = screen.getByRole("button", { name: /^Luna Connect$/i });
    expect(lunaConnectToggle).toHaveAttribute("aria-expanded", "false");

    await user.click(lunaConnectToggle);
    expect(lunaConnectToggle).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: /Change device token/i }));

    expect(
      await screen.findByText(/Paste your device token from/i),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "connect.luna.libreloom.org" })).toHaveAttribute(
      "href",
      "https://connect.luna.libreloom.org",
    );
    expect(screen.getByLabelText("Device token from Luna Connect")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save device token/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn Luna Connect off/i })).toBeNull();
  });

  it("offers remove in the device-token modal when Connect is active", async () => {
    const user = userEvent.setup();
    const baseFetch = stubFetch();
    const fetchImpl = vi.fn(async (path, options) => {
      if (path.startsWith("/api/v1/connect/status")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            connect_active: true,
            hostname: "kitchen.luna.servers.libreloom.org",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseFetch(path, options);
    });
    renderPage(fetchImpl);
    await screen.findByText("Default source");

    await user.click(screen.getByRole("button", { name: /^Luna Connect$/i }));
    await user.click(screen.getByRole("button", { name: /Change device token/i }));

    expect(await screen.findByRole("button", { name: /Remove device token/i })).toBeTruthy();
    expect(screen.getByLabelText("Device token from Luna Connect")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn Luna Connect off/i })).toBeNull();
  });

  it("flags a custom source when keys differ from the built-in key", async () => {
    const user = userEvent.setup();
    renderPage(stubFetch({
      ...SOURCE_RESPONSE,
      feed_url: "https://staging.feeds.test/feeds",
      keys: ["RWCUSTOM"],
      effective_keys: ["RWCUSTOM"],
      default_keys: false,
    }));
    await openAdvanced(user);
    expect(await screen.findByText("Custom source")).toBeTruthy();
    expect(screen.getByText("https://staging.feeds.test/feeds")).toBeTruthy();
  });

  it("opens the edit modal with the warning copy and prefilled fields", async () => {
    const user = userEvent.setup();
    renderPage(stubFetch());
    await openEditor(user);

    expect(
      await screen.findByText(/Only change these if your updates come from somewhere else/i),
    ).toBeTruthy();
    expect(screen.getByLabelText(/What these settings control/i)).toBeTruthy();
    const feedInput = /** @type {HTMLInputElement} */ (screen.getByPlaceholderText(FEED_URL));
    expect(feedInput.value).toBe(FEED_URL);
    const keysField = /** @type {HTMLTextAreaElement} */ (
      screen.getByRole("textbox", { name: /Signing keys/i })
    );
    expect(keysField.value).toBe(SHIPPED_KEY);
  });

  it("saves the new feed address with a PUT and closes the modal", async () => {
    const user = userEvent.setup();
    const fetchImpl = stubFetch();
    renderPage(fetchImpl);
    await openEditor(user);

    await user.clear(screen.getByPlaceholderText(FEED_URL));
    await user.type(screen.getByPlaceholderText(FEED_URL), "https://staging.feeds.test/feeds");
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    const calls = /** @type {[string, any][]} */ (fetchImpl.mock.calls);
    const put = calls.find(
      ([path, options]) => path.endsWith("/updates/source") && options?.method === "PUT",
    );
    expect(put).toBeTruthy();
    const body = JSON.parse(put?.[1]?.body ?? "{}");
    expect(body).toEqual({
      feed_url: "https://staging.feeds.test/feeds",
      channel: "stable",
      keys: [],
    });
  });

  it("blocks a save with an invalid signing key", async () => {
    const user = userEvent.setup();
    renderPage(stubFetch());
    await openEditor(user);

    const keysField = await screen.findByRole("textbox", { name: /Signing keys/i });
    await user.clear(keysField);
    await user.type(keysField, "not-a-key");
    await user.click(screen.getByRole("button", { name: /Save changes/i }));

    expect(await screen.findByText(/not a valid minisign public key/i)).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { dashboard as greetingMessages } from "../assets/greetings.jsx";
import DashboardPage from "./DashboardPage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.username]
 * @param {string} [opts.role]
 * @param {number} [opts.uptime]
 * @param {any} [opts.drives]
 * @param {any} [opts.detected]
 * @param {any} [opts.network]
 * @param {any} [opts.connect]
 * @param {boolean} [opts.connectActive]
 * @param {any} [opts.jobs]
 * @param {any} [opts.access]
 * @param {Record<string, any>} [opts.summaries]
 */
function stubFetch({
  username = "max",
  role = "admin",
  uptime = 7200,
  drives = [{ id: "d1", label: "Family photos", state: "as_is", device: "sda1", fs_type: "exfat" }],
  detected = [],
  network = { ethernet_connected: true, wifi_connected: false, has_default_route: true },
  /** @type {any} */
  connect = { enabled: true, tunnel_active: true, domain: "luna.example" },
  connectActive = false,
  jobs = [],
  access = [],
  summaries = {
    d1: {
      id: "d1",
      mounted: true,
      total_bytes: 64_000_000_000,
      free_bytes: 12_000_000_000,
      used_bytes: 52_000_000_000,
      folders: 3,
      files: 12,
      shortcuts: ["Photos", "Documents"],
    },
  },
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) {
        return jsonResponse({ id: "1", username, role });
      }
      if (u.endsWith("/api/v1/auth/status")) {
        return jsonResponse({ has_admin: role === "admin", connect_active: connectActive });
      }
      if (u.endsWith("/api/v1/setup")) {
        return jsonResponse({ name: "Luna", setup_completed: true });
      }
      if (u.endsWith("/api/v1/health")) {
        return jsonResponse({ status: "ok", uptime_seconds: uptime });
      }
      if (u.endsWith("/api/v1/drives/detected")) return jsonResponse(detected);
      if (u.endsWith("/api/v1/drives")) return jsonResponse(drives);
      const summaryMatch = u.match(/\/api\/v1\/drives\/([^/]+)\/summary$/);
      if (summaryMatch) {
        const id = summaryMatch[1];
        if (summaries[id]) return jsonResponse(summaries[id]);
        return jsonResponse({
          id,
          mounted: false,
          total_bytes: null,
          free_bytes: null,
          used_bytes: null,
          folders: null,
          files: null,
          shortcuts: [],
        });
      }
      if (u.includes("/api/v1/network/status")) {
        if (network === 403) return jsonResponse({ error: "nope" }, 403);
        return jsonResponse(network);
      }
      if (u.includes("/api/v1/connect/status")) {
        if (connect === 403) return jsonResponse({ error: "nope" }, 403);
        return jsonResponse(connect);
      }
      if (u.includes("/api/v1/jobs")) return jsonResponse(jobs);
      if (u.endsWith("/api/v1/me/access")) return jsonResponse(access);
      const inspectMatch = u.match(/\/api\/v1\/drives\/([^/]+)\/inspect$/);
      if (inspectMatch) {
        return jsonResponse({
          device: inspectMatch[1],
          model: "SanDisk",
          fs_type: "exfat",
          readable: true,
          writable: true,
          needs_erase: false,
          has_marker: false,
          folders: 1,
          files: 2,
          entries: [
            { kind: "folder", name: "Photos" },
            { kind: "file", name: "readme.txt" },
          ],
        });
      }
      return jsonResponse({}, 404);
    }),
  );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <DashboardPage />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("DashboardPage", () => {
  it("greets the signed-in user and shows uptime and drives", async () => {
    stubFetch({ connectActive: true });
    renderPage();
    const heading = await screen.findByRole("heading", { name: /max/i });
    expect(heading).toBeInTheDocument();
    const greetingBit = heading.textContent.replace(/,?\s*max\s*$/i, "").trim();
    const known = greetingMessages.some((g) => g.replace(/,\s*$/, "").trim() === greetingBit)
      || /Happy|Merry/.test(greetingBit);
    expect(known).toBe(true);
    expect(await screen.findByText(/2 hours/i)).toBeInTheDocument();
    expect(screen.getByText("Family photos")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Browse files/i })).toHaveAttribute("href", "/drives/d1");
    expect(screen.getByText(/On this network/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Remote access on/i })).toHaveAttribute(
      "href",
      "/settings#external_services",
    );
    expect(screen.getByRole("link", { name: /Remote access on/i }).textContent).toContain(
      "luna.example",
    );
    expect(screen.queryByText(/What to do next/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No subscription/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Anywhere, free/i)).not.toBeInTheDocument();
  });

  it("helps when there are no drives yet", async () => {
    stubFetch({ drives: [] });
    renderPage();
    expect(await screen.findByText(/No drives yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Drives/i })).toHaveAttribute("href", "/drives");
    expect(screen.queryByText(/No subscription/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/free forever/i)).not.toBeInTheDocument();
  });

  it("flags a newly plugged-in USB for admins", async () => {
    stubFetch({
      drives: [],
      detected: [{ name: "sdb", model: "SanDisk", size_bytes: 32_000_000_000 }],
    });
    renderPage();
    expect(await screen.findByText(/New drive plugged in/i)).toBeInTheDocument();
    // "Add drive" must be a button (opens modal) — not a navigation link.
    const addBtn = screen.getByRole("button", { name: /^Add drive$/i });
    expect(addBtn).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Add drive$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing on the drive changes until you confirm/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Look inside/i })).not.toBeInTheDocument();
  });

  it("opens a drive-picker modal when 'Add drive' is clicked", async () => {
    const user = userEvent.setup();
    stubFetch({
      drives: [],
      detected: [{ name: "sdb", model: "SanDisk", size_bytes: 32_000_000_000, usb: true, fs_type: "exfat" }],
    });
    renderPage();
    const addBtn = await screen.findByRole("button", { name: /^Add drive$/i });
    await user.click(addBtn);
    // Modal should open listing the drive
    expect(await screen.findByText(/New drive detected/i)).toBeInTheDocument();
    expect(screen.getByText("SanDisk")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Not now/i })).toBeInTheDocument();
  });

  it("opens the inspect wizard when a listed drive is selected", async () => {
    const user = userEvent.setup();
    stubFetch({
      drives: [],
      detected: [{ name: "sdb", model: "SanDisk", size_bytes: 32_000_000_000, usb: true, fs_type: "exfat" }],
    });
    renderPage();
    await user.click(await screen.findByRole("button", { name: /^Add drive$/i }));
    expect(await screen.findByText(/New drive detected/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /SanDisk/i }));
    // Picker unmounts; shared InspectModal opens for setup.
    expect(screen.queryByText(/New drive detected/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/Add SanDisk/i)).toBeInTheDocument();
    expect(await screen.findByText(/Photos/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Add this drive$/i })).toBeInTheDocument();
  });

  it("loads network status for a household member, not only an admin", async () => {
    stubFetch({ username: "sam", role: "user", connect: 403 });
    renderPage();
    expect(await screen.findByText(/On this network/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Remote access/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/What to do next/i)).not.toBeInTheDocument();
  });

  it("shows remote access as a single link when it is off", async () => {
    stubFetch({ connectActive: true, connect: { enabled: false, tunnel_active: false } });
    renderPage();
    expect(await screen.findByRole("link", { name: /Remote access off/i })).toHaveAttribute(
      "href",
      "/settings#external_services",
    );
    expect(screen.queryByRole("link", { name: /^Remote access$/i })).not.toBeInTheDocument();
    const wrap = document.querySelector("[data-slot=remote-access-link]");
    expect(wrap).toHaveAttribute("data-stacked", "false");
    expect(document.querySelector("[data-slot=remote-access-probe]")).toBeNull();
  });

  it("hides remote access when Luna Connect is inactive on the device", async () => {
    stubFetch({ connectActive: false });
    renderPage();
    expect(await screen.findByText(/On this network/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Remote access/i })).not.toBeInTheDocument();
  });

  describe("remote access fit-or-stack", () => {
    /** @type {ResizeObserverCallback[]} */
    let observers = [];
    /** @type {{ clientWidth: number }} */
    let remoteContainer;
    /** @type {{ scrollWidth: number }} */
    let remoteProbe;

    beforeEach(() => {
      observers = [];
      remoteContainer = { clientWidth: 900 };
      remoteProbe = { scrollWidth: 200 };

      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get() {
          if (this.getAttribute?.("data-slot") === "remote-access-link") {
            return remoteContainer.clientWidth;
          }
          return 1200;
        },
      });
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
        configurable: true,
        get() {
          // Inner w-max row of the clipped remote-access probe.
          if (this.parentElement?.getAttribute?.("data-slot") === "remote-access-probe") {
            return remoteProbe.scrollWidth;
          }
          return 200;
        },
      });

      globalThis.ResizeObserver = class {
        /** @param {ResizeObserverCallback} cb */
        constructor(cb) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      // @ts-expect-error cleanup test polyfill
      delete HTMLElement.prototype.clientWidth;
      // @ts-expect-error cleanup test polyfill
      delete HTMLElement.prototype.scrollWidth;
    });

    it("keeps a single-line pill when status and hostname fit", async () => {
      remoteContainer = { clientWidth: 900 };
      remoteProbe = { scrollWidth: 200 };
      stubFetch({
        connectActive: true,
        connect: {
          enabled: true,
          tunnel_active: true,
          domain: "max.luna.servers.libreloom.org",
        },
      });
      const { container } = renderPage();
      expect(await screen.findByRole("link", { name: /Remote access on/i })).toBeInTheDocument();

      vi.useFakeTimers();
      await act(async () => {
        vi.advanceTimersByTime(60);
        observers.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
      });

      const wrap = container.querySelector("[data-slot=remote-access-link]");
      expect(wrap).toHaveAttribute("data-stacked", "false");
      const link = screen.getByRole("link", { name: /Remote access on/i });
      expect(link.className).toMatch(/rounded-pill/);
      expect(link.className).not.toMatch(/rounded-large-element/);
      expect(link.querySelector(".flex-col")).toBeNull();
      // Visible link + aria-hidden measure probe both render the hostname.
      expect(screen.getAllByText("max.luna.servers.libreloom.org").length).toBeGreaterThanOrEqual(1);
    });

    it("stacks into a multilined card when hostname cannot fit beside the status", async () => {
      remoteContainer = { clientWidth: 280 };
      remoteProbe = { scrollWidth: 520 };
      stubFetch({
        connectActive: true,
        connect: {
          enabled: true,
          tunnel_active: true,
          domain: "max.luna.servers.libreloom.org",
        },
      });
      const { container } = renderPage();
      expect(await screen.findByRole("link", { name: /Remote access on/i })).toBeInTheDocument();

      vi.useFakeTimers();
      await act(async () => {
        vi.advanceTimersByTime(60);
        observers.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
      });

      const wrap = container.querySelector("[data-slot=remote-access-link]");
      expect(wrap).toHaveAttribute("data-stacked", "true");
      const link = screen.getByRole("link", { name: /Remote access on/i });
      // Must be a card radius — rounded-pill must not remain (twMerge conflict bug).
      expect(link.className).toMatch(/rounded-large-element/);
      expect(link.className).not.toMatch(/rounded-pill/);
      expect(link.className).toMatch(/items-stretch/);
      // Label and domain are in a column (not a cramped single-line pill).
      expect(link.querySelector(".flex-col")).toBeTruthy();
      expect(link.textContent).toContain("max.luna.servers.libreloom.org");
      const probe = container.querySelector("[data-slot=remote-access-probe]");
      expect(probe?.className).toMatch(/\bw-0\b/);
      expect(probe?.className).toMatch(/overflow-hidden/);
    });
  });

  it("shows storage, root counts, and folder shortcuts on drive cards", async () => {
    stubFetch();
    renderPage();
    expect(await screen.findByText(/12 GB free/i)).toBeInTheDocument();
    expect(screen.getByText(/52 GB used/i)).toBeInTheDocument();
    expect(screen.getByText(/3 folders · 12 files at the/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^root$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Photos" })).toHaveAttribute(
      "href",
      "/drives/d1?path=Photos",
    );
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/drives/d1?path=Documents",
    );
    expect(screen.getByRole("progressbar", { name: /81% used/i })).toBeInTheDocument();
  });

  it("does not invent storage numbers for an unplugged drive", async () => {
    stubFetch({
      drives: [{ id: "d2", label: "Travel stick", state: "missing" }],
      summaries: {},
    });
    renderPage();
    expect(
      await screen.findByText(/Unplugged\. Plug it back in when you want/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Needs a look/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open Drives/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/GB free/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows detailed recent copy jobs with progress and destination", async () => {
    stubFetch({
      jobs: [
        {
          id: "j1",
          kind: "move",
          state: "running",
          from_drive: "d1",
          from_path: "Photos/vacation.jpg",
          to_drive: "d1",
          to_path: "Documents",
          progress: 40,
          total: 100,
          error: "",
        },
        {
          id: "j2",
          kind: "copy",
          state: "done",
          from_drive: "d1",
          from_path: "Music/song.mp3",
          to_drive: "d1",
          to_path: "Downloads",
          progress: 1,
          total: 1,
          error: "",
        },
      ],
    });
    renderPage();
    expect(await screen.findByText("Recent activity")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText("Moving")).toBeInTheDocument();
    expect(screen.getByText("vacation.jpg")).toBeInTheDocument();
    expect(screen.getByText(/Family photos: vacation\.jpg → Documents/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /40% done/i })).toBeInTheDocument();
    expect(screen.getByText("song.mp3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open destination/i })).toHaveAttribute(
      "href",
      "/drives/d1?path=Downloads",
    );
  });
});

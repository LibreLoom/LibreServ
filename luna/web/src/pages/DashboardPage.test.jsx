import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
 * @param {any} [opts.jobs]
 * @param {any} [opts.access]
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
  jobs = [],
  access = [],
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) {
        return jsonResponse({ id: "1", username, role });
      }
      if (u.endsWith("/api/v1/setup")) {
        return jsonResponse({ name: "Luna", setup_completed: true });
      }
      if (u.endsWith("/api/v1/health")) {
        return jsonResponse({ status: "ok", uptime_seconds: uptime });
      }
      if (u.endsWith("/api/v1/drives/detected")) return jsonResponse(detected);
      if (u.endsWith("/api/v1/drives")) return jsonResponse(drives);
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
    stubFetch();
    renderPage();
    expect(await screen.findByText("max")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: /max/i });
    const greetingBit = heading.textContent.replace(/,?\s*max\s*$/i, "").trim();
    const known = greetingMessages.some((g) => g.replace(/,\s*$/, "").trim() === greetingBit)
      || /Happy|Merry/.test(greetingBit);
    expect(known).toBe(true);
    expect(await screen.findByText(/2 hours/i)).toBeInTheDocument();
    expect(screen.getByText("Family photos")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open files/i })).toHaveAttribute("href", "/drives/d1");
    expect(screen.getByText(/On this network/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Remote access on/i })).toHaveAttribute(
      "href",
      "/settings/remote",
    );
    expect(screen.getByText("luna.example")).toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: /Look inside/i })).toHaveAttribute("href", "/drives");
  });

  it("loads network status for a household member, not only an admin", async () => {
    stubFetch({ username: "sam", role: "user", connect: 403 });
    renderPage();
    expect(await screen.findByText(/On this network/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Remote access/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/What to do next/i)).not.toBeInTheDocument();
  });

  it("shows remote access as a single link when it is off", async () => {
    stubFetch({ connect: { enabled: false, tunnel_active: false } });
    renderPage();
    expect(await screen.findByRole("link", { name: /Remote access off/i })).toHaveAttribute(
      "href",
      "/settings/remote",
    );
    expect(screen.queryByRole("link", { name: /^Remote access$/i })).not.toBeInTheDocument();
  });
});

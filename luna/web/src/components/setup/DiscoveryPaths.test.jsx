import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DiscoveryPaths from "./DiscoveryPaths";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch({ network = {}, connect = /** @type {Record<string, unknown>} */ ({}) } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/api/v1/connect/status")) {
      return jsonResponse({
        connect_active: Boolean(connect.hostname || connect.domain),
        enabled: Boolean(connect.hostname || connect.domain),
        hostname: null,
        domain: null,
        ...connect,
      });
    }
    if (u.includes("/network/status")) {
      return jsonResponse({
        ethernet_connected: true,
        has_default_route: true,
        ipv4: [],
        ...network,
      });
    }
    return jsonResponse({ error: "not found" }, 404);
  });
}

function renderPaths() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DiscoveryPaths />
    </QueryClientProvider>,
  );
}

describe("DiscoveryPaths", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Everywhere above home addresses when remote access is configured", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        network: { ipv4: ["192.168.1.118"] },
        connect: { hostname: "kitchen.luna.servers.libreloom.org", enabled: true },
      }),
    );
    renderPaths();
    expect(await screen.findByText("Everywhere:")).toBeTruthy();
    const remoteLink = screen.getByRole("link", { name: "kitchen.luna.servers.libreloom.org" });
    expect(remoteLink).toHaveAttribute("href", "https://kitchen.luna.servers.libreloom.org");
    expect(remoteLink).toHaveAttribute("target", "_blank");
    expect(remoteLink).toHaveAttribute("rel", "noreferrer");
    expect(remoteLink.className).toMatch(/underline/);
    expect(remoteLink.className).toMatch(/hover:no-underline/);
    expect(screen.getByText("On your home internet only:")).toBeTruthy();
    const localLink = screen.getByRole("link", { name: "luna.local" });
    expect(localLink).toHaveAttribute("href", "http://luna.local");
    expect(localLink).toHaveAttribute("target", "_blank");
    expect(localLink).toHaveAttribute("rel", "noreferrer");
    const ipLink = screen.getByRole("link", { name: "192.168.1.118" });
    expect(ipLink).toHaveAttribute("href", "http://192.168.1.118");
    expect(ipLink).toHaveAttribute("target", "_blank");
    expect(ipLink).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByText(/if your phone finds it/i)).toBeNull();
    expect(screen.queryByText(/current address on the screen/i)).toBeNull();
    expect(screen.queryByText(/Stay on your home internet/i)).toBeNull();
  });

  it("hides Everywhere when remote access is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        network: { ipv4: ["192.168.1.20"] },
      }),
    );
    renderPaths();
    expect(await screen.findByRole("link", { name: "192.168.1.20" })).toHaveAttribute(
      "href",
      "http://192.168.1.20",
    );
    expect(screen.queryByText("Everywhere:")).toBeNull();
    expect(screen.getByText("On your home internet only:")).toBeTruthy();
    expect(screen.getByRole("link", { name: "luna.local" })).toHaveAttribute("href", "http://luna.local");
  });

  it("hides Everywhere when the device token was rejected", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        network: { ipv4: ["192.168.1.20"] },
        connect: {
          hostname: "kitchen.luna.servers.libreloom.org",
          enabled: false,
          device_token_error: "Connect did not accept this device token.",
        },
      }),
    );
    renderPaths();
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.queryByText("Everywhere:")).toBeNull();
    expect(screen.queryByText("kitchen.luna.servers.libreloom.org")).toBeNull();
  });
});

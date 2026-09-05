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

function renderPaths(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DiscoveryPaths {...props} />
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
    renderPaths({ name: "Kitchen" });
    expect(await screen.findByText("Everywhere:")).toBeTruthy();
    expect(screen.getByText("Access Kitchen here:")).toBeTruthy();
    expect(screen.getByText("kitchen.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText("On your home internet only:")).toBeTruthy();
    expect(screen.getByText("luna.local")).toBeTruthy();
    expect(screen.getByText("192.168.1.118")).toBeTruthy();
    expect(screen.queryByText(/if your phone finds it/i)).toBeNull();
    expect(screen.queryByText(/current address on the screen/i)).toBeNull();
    expect(screen.queryByText(/Stay on your home internet/i)).toBeNull();
  });

  it("falls back to Luna in the heading when name is missing", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        network: { ipv4: ["192.168.1.20"] },
      }),
    );
    renderPaths();
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.getByText("Access Luna here:")).toBeTruthy();
  });

  it("falls back to Luna when name is blank", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        network: { ipv4: ["192.168.1.20"] },
      }),
    );
    renderPaths({ name: "   " });
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.getByText("Access Luna here:")).toBeTruthy();
  });

  it("hides Everywhere when remote access is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        network: { ipv4: ["192.168.1.20"] },
      }),
    );
    renderPaths({ name: "Studio" });
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.getByText("Access Studio here:")).toBeTruthy();
    expect(screen.queryByText("Everywhere:")).toBeNull();
    expect(screen.getByText("On your home internet only:")).toBeTruthy();
    expect(screen.getByText("luna.local")).toBeTruthy();
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
    renderPaths({ name: "Kitchen" });
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.getByText("Access Kitchen here:")).toBeTruthy();
    expect(screen.queryByText("Everywhere:")).toBeNull();
    expect(screen.queryByText("kitchen.luna.servers.libreloom.org")).toBeNull();
  });
});

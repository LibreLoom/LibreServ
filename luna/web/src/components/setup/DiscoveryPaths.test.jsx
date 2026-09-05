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
    expect(await screen.findByText("From anywhere (when Luna Connect is on):")).toBeTruthy();
    expect(screen.getByText("kitchen.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByText("On your home network only:")).toBeTruthy();
    expect(screen.getByText("luna.local")).toBeTruthy();
    expect(screen.getByText("192.168.1.118")).toBeTruthy();
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
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.queryByText("From anywhere (when Luna Connect is on):")).toBeNull();
    expect(screen.getByText("On your home network only:")).toBeTruthy();
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
    renderPaths();
    expect(await screen.findByText("192.168.1.20")).toBeTruthy();
    expect(screen.queryByText("From anywhere (when Luna Connect is on):")).toBeNull();
    expect(screen.queryByText("kitchen.luna.servers.libreloom.org")).toBeNull();
  });
});

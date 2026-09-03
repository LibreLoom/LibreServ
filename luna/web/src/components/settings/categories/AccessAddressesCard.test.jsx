import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AccessAddressesCard from "./AccessAddressesCard";

function stubFetch({ network, connect } = {}) {
  return vi.fn(async (path) => {
    if (String(path).includes("/network/status")) {
      return new Response(
        JSON.stringify(
          network ?? {
            ethernet_connected: true,
            has_default_route: true,
            ipv4: ["192.168.1.20"],
          },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (String(path).includes("/connect/status")) {
      return new Response(JSON.stringify(connect ?? { enabled: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
}

function renderCard(fetchImpl) {
  vi.stubGlobal("fetch", fetchImpl);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AccessAddressesCard />
    </QueryClientProvider>,
  );
}

describe("AccessAddressesCard", () => {
  it("shows public and home addresses when Connect is configured", async () => {
    renderCard(
      stubFetch({
        connect: {
          enabled: true,
          hostname: "kitchen.luna.servers.libreloom.org",
        },
      }),
    );

    expect(
      await screen.findByDisplayValue("https://kitchen.luna.servers.libreloom.org"),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Everywhere" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "On your home network only" })).toBeTruthy();
    expect(screen.getByDisplayValue("http://luna.local")).toBeTruthy();
    expect(await screen.findByDisplayValue("http://192.168.1.20")).toBeTruthy();
  });

  it("omits Everywhere when there is no public address", async () => {
    renderCard(stubFetch({ connect: { enabled: false } }));

    expect(await screen.findByDisplayValue("http://luna.local")).toBeTruthy();
    expect(await screen.findByDisplayValue("http://192.168.1.20")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Everywhere" })).toBeNull();
    expect(screen.queryByText(/None yet/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "On your home network only" })).toBeTruthy();
  });

  it("omits the LAN IP when none is available", async () => {
    renderCard(
      stubFetch({
        network: {
          ethernet_connected: false,
          has_default_route: false,
          ipv4: [],
        },
      }),
    );

    expect(await screen.findByDisplayValue("http://luna.local")).toBeTruthy();
    expect(screen.queryByText(/Waiting for an address/i)).toBeNull();
    expect(screen.queryByText(/Not plugged in/i)).toBeNull();
    expect(screen.queryByDisplayValue(/^http:\/\/\d/)).toBeNull();
  });
});

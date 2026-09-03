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
  it("splits addresses into everywhere and home network", async () => {
    renderCard(
      stubFetch({
        connect: {
          enabled: true,
          hostname: "kitchen.luna.servers.libreloom.org",
        },
      }),
    );

    expect(await screen.findByRole("heading", { name: "Where to open Luna" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Everywhere" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "On your home network only" })).toBeTruthy();

    expect(
      await screen.findByDisplayValue("https://kitchen.luna.servers.libreloom.org"),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("http://luna.local")).toBeTruthy();
    expect(screen.getByDisplayValue("http://192.168.1.20")).toBeTruthy();
    expect(screen.queryByText(/Type one of these addresses/i)).toBeNull();
    expect(screen.queryByText(/friendly name/i)).toBeNull();
  });

  it("shows a short empty state when there is no public address", async () => {
    renderCard(stubFetch({ connect: { enabled: false } }));

    expect(await screen.findByText("None yet")).toBeTruthy();
    expect(screen.queryByDisplayValue(/^https:\/\//)).toBeNull();
    expect(screen.getByDisplayValue("http://luna.local")).toBeTruthy();
  });

  it("shows a short empty state when the cable is out", async () => {
    renderCard(
      stubFetch({
        network: {
          ethernet_connected: false,
          has_default_route: false,
          ipv4: [],
        },
      }),
    );

    expect(await screen.findByText("Not plugged in")).toBeTruthy();
    expect(screen.getByDisplayValue("http://luna.local")).toBeTruthy();
  });
});

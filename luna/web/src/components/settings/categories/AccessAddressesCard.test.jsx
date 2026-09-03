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
  });

  it("explains when there is no public address yet", async () => {
    renderCard(stubFetch({ connect: { enabled: false } }));

    expect(await screen.findByText(/No public address yet/i)).toBeTruthy();
    expect(screen.queryByDisplayValue(/^https:\/\//)).toBeNull();
    expect(screen.getByDisplayValue("http://luna.local")).toBeTruthy();
  });

  it("explains a missing network address when the cable is out", async () => {
    renderCard(
      stubFetch({
        network: {
          ethernet_connected: false,
          has_default_route: false,
          ipv4: [],
        },
      }),
    );

    expect(
      await screen.findByText(/Plug Luna into your router or modem/i),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("http://luna.local")).toBeTruthy();
  });
});

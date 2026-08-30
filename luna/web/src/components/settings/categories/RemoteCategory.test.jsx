import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import RemoteCategory from "./RemoteCategory";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <RemoteCategory />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("RemoteCategory", () => {
  it("points at About → Advanced when Connect is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ enabled: false }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    renderPage();
    expect(await screen.findByRole("link", { name: /Open About → Advanced/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use the code that came with this Luna/i })).toBeTruthy();
    expect(screen.getByText(/connect\.luna\.libreloom\.org/i)).toBeTruthy();
    expect(screen.getAllByText(/About → Advanced/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Other options/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tailscale/i)).not.toBeInTheDocument();
  });

  it("shows hostname and change field when on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        enabled: true,
        hostname: "photos.luna.servers.libreloom.org",
        domain: "photos.luna.servers.libreloom.org",
        tunnel_active: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    renderPage();
    expect(await screen.findByDisplayValue("https://photos.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByLabelText("Luna Connect address")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save new address/i })).toBeTruthy();
    expect(screen.getByText(/free forever/i)).toBeTruthy();
  });
});

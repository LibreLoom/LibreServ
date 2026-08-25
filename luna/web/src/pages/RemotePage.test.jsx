import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import RemotePage from "./RemotePage";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <RemotePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("RemotePage", () => {
  it("asks for a name when Connect is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ enabled: false }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    renderPage();
    expect(await screen.findByRole("button", { name: /Save code/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use booklet code/i })).toBeTruthy();
    expect(screen.getByText(/connect\.luna\.libreloom\.org/i)).toBeTruthy();
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
    expect(await screen.findByText("photos.luna.servers.libreloom.org")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy address/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Save new address/i })).toBeTruthy();
  });
});

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
  it("asks for a code when Connect is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ enabled: false }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    renderPage();
    expect(await screen.findByRole("button", { name: /Save code/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use booklet code/i })).toBeTruthy();
    expect(screen.getByText(/connect\.luna\.libreloom\.org/i)).toBeTruthy();
    expect(screen.getByText(/free forever/i)).toBeTruthy();
  });

  it("stacks connect code label above a full-width input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ enabled: false }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    renderPage();
    expect(await screen.findByText(/Code from the Luna Connect site/i)).toBeTruthy();

    const row = screen.getByText(/Code from the Luna Connect site/i).closest('[data-slot="settings-row"]');
    expect(row?.className).toMatch(/flex-col/);
    expect(row?.className).toMatch(/lg:flex-row/);

    const input = screen.getByPlaceholderText(/Six letters from the site/i);
    expect(input.className).toMatch(/w-full/);
    expect(input.className).toMatch(/min-w-0/);
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

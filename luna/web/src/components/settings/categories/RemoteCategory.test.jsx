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
  it("shows Luna Connect link copy when Connect is off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ enabled: false }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ));
    renderPage();
    expect(await screen.findByText(/Configure your subdomain & add cloud backup on/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Luna Connect" });
    expect(link).toHaveAttribute("href", "https://connect.luna.libreloom.org");
    expect(screen.queryByRole("button", { name: /Save new address/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turn Luna Connect off/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sync with Luna Connect/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/About → Advanced/i)).not.toBeInTheDocument();
  });

  it("shows read-only address and Luna Connect link when on", async () => {
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
    expect(screen.getByRole("link", { name: "Luna Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Save new address/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Turn Luna Connect off/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("kitchen")).not.toBeInTheDocument();
  });
});

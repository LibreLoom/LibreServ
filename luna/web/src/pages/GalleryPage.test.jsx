import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import GalleryPage from "./GalleryPage";

describe("GalleryPage", () => {
  it("invites you to choose a drive and build the gallery", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Photos Drive", state: "as_is" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><GalleryPage /></MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getAllByText(/Photos/i).length).toBeGreaterThan(0);
  });
});

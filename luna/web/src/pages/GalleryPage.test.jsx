import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import GalleryPage from "./GalleryPage";

function renderGallery() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GalleryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("GalleryPage", () => {
  it("shows photos from every drive without asking which one", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([
          { id: "a", label: "Family" },
          { id: "b", label: "Travel" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/gallery/scan")) {
        return new Response(JSON.stringify({ started: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/gallery")) {
        return new Response(JSON.stringify([
          { drive_id: "a", path: "one.jpg", name: "one.jpg", taken_at: 0, thumb: "" },
          { drive_id: "b", path: "two.jpg", name: "two.jpg", taken_at: 0, thumb: "" },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderGallery();
    expect(await screen.findByText("one.jpg")).toBeInTheDocument();
    expect(screen.getByText("two.jpg")).toBeInTheDocument();
    expect(screen.queryByText(/Choose a drive/i)).not.toBeInTheDocument();
  });

  it("points people to Drives when there is nothing to look in", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/gallery/scan")) {
        return new Response(JSON.stringify({ started: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderGallery();
    expect(await screen.findByText(/No drives to look in/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Drives/i })).toHaveAttribute("href", "/drives");
  });
});

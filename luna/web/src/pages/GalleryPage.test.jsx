import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import GalleryPage, { galleryUrl } from "./GalleryPage";

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

describe("galleryUrl", () => {
  it("asks for favorites with true/false that lunad can parse", () => {
    expect(galleryUrl({ favorites: true, offset: 0 })).toContain("favorites=true");
    expect(galleryUrl({ favorites: true, offset: 0 })).not.toMatch(/favorites=1(?:&|$)/);
    expect(galleryUrl({ favorites: false, offset: 0 })).not.toContain("favorites=");
  });
});

describe("GalleryPage", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

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
        return new Response(JSON.stringify({
          items: [
            { drive_id: "a", path: "one.jpg", name: "one.jpg", taken_at: 1_700_000_000, thumb: "/t1", kind: "image" },
            { drive_id: "b", path: "two.jpg", name: "two.jpg", taken_at: 1_700_000_100, thumb: "/t2", kind: "image" },
          ],
          next_offset: 2,
          has_more: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderGallery();
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("two.jpg")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });

  it("points people to Drives when there is nothing to look in", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/gallery/scan")) {
        return new Response(JSON.stringify({ started: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/gallery?")) {
        return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderGallery();
    expect(await screen.findByText(/No drives to look in/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Drives/i })).toHaveAttribute("href", "/drives");
  });

  it("loads Favorites with favorites=true and shows favorited photos", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/scan")) {
        return new Response(JSON.stringify({ started: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery?")) {
        const favoritedOnly = u.includes("favorites=true");
        const items = favoritedOnly
          ? [
              {
                drive_id: "a",
                path: "fav.jpg",
                name: "fav.jpg",
                taken_at: 1_700_000_000,
                thumb: "/tf",
                kind: "image",
                favorited: true,
              },
            ]
          : [
              {
                drive_id: "a",
                path: "other.jpg",
                name: "other.jpg",
                taken_at: 1_700_000_050,
                thumb: "/to",
                kind: "image",
                favorited: false,
              },
            ];
        return new Response(JSON.stringify({ items, next_offset: 1, has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderGallery();
    expect(await screen.findByLabelText("other.jpg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Favorites/i }));

    expect(await screen.findByLabelText("fav.jpg")).toBeInTheDocument();
    expect(screen.queryByLabelText("other.jpg")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("favorites=true")),
      ).toBe(true);
    });
    expect(fetchMock.mock.calls.every(([url]) => !/favorites=1(?:&|$)/.test(String(url)))).toBe(
      true,
    );
  });

  it("explains an empty Favorites list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.endsWith("/drives")) {
          return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/gallery?")) {
          return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderGallery();
    fireEvent.click(await screen.findByRole("radio", { name: /Favorites/i }));
    expect(await screen.findByText(/No favorites yet/i)).toBeInTheDocument();
    expect(screen.getByText(/tap the heart/i)).toBeInTheDocument();
  });
});

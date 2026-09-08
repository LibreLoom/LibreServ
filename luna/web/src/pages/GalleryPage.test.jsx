import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import GalleryPage, { galleryUrl, parseGalleryHash } from "./GalleryPage";

const STATUS_OK = { scanning: false, pending: 0, busy: false };

/** @param {{ places?: unknown[], albums?: unknown[], albumsHold?: Promise<void>, galleryHold?: Promise<void>, galleryItems?: unknown[] | null }} [options] */
function stubGalleryFetch({ places = [], albums = [], albumsHold, galleryHold, galleryItems } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(
          JSON.stringify([
            { id: "a", label: "Family" },
            { id: "b", label: "Travel" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/gallery/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/places")) {
        return new Response(JSON.stringify(places), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/albums")) {
        if (albumsHold) await albumsHold;
        return new Response(JSON.stringify(albums), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery")) {
        if (galleryHold) await galleryHold;
        const items =
          galleryItems !== undefined
            ? galleryItems
            : [
                {
                  drive_id: "a",
                  path: "one.jpg",
                  name: "one.jpg",
                  taken_at: 1_700_000_000,
                  thumb: "/t1",
                  kind: "image",
                },
                {
                  drive_id: "b",
                  path: "two.jpg",
                  name: "two.jpg",
                  taken_at: 1_700_000_100,
                  thumb: "/t2",
                  kind: "image",
                },
              ];
        return new Response(
          JSON.stringify({
            items: items || [],
            next_offset: (items || []).length,
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

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

  it("wires day bounds as from/to unix seconds", () => {
    const url = galleryUrl({ from: 1700000000, to: 1700086399, offset: 0 });
    expect(url).toContain("from=1700000000");
    expect(url).toContain("to=1700086399");
  });

  it("asks for archived and kind filters", () => {
    expect(galleryUrl({ archived: true })).toContain("archived=true");
    expect(galleryUrl({ kind: "video" })).toContain("kind=video");
  });

  it("includes camera_make and place_bbox when set", () => {
    const url = galleryUrl({
      cameraMake: "Canon",
      cameraModel: "EOS R5",
      placeBbox: "-10,20,-5,30",
    });
    expect(url).toContain("camera_make=Canon");
    expect(url).toContain("camera_model=EOS");
    expect(url).toContain("place_bbox=-10%2C20%2C-5%2C30");
  });

  it("wires undated and album_membership", () => {
    expect(galleryUrl({ undated: true })).toContain("undated=true");
    expect(galleryUrl({ albumMembership: "none" })).toContain("album_membership=none");
    expect(galleryUrl({ albumMembership: "any" })).toContain("album_membership=any");
    expect(galleryUrl({ albumMembership: "maybe" })).not.toContain("album_membership=");
  });
});

describe("parseGalleryHash", () => {
  it("parses day deep links", () => {
    expect(parseGalleryHash("#day/2024-06-01")).toEqual({
      segment: "library",
      day: "2024-06-01",
    });
  });
});

describe("GalleryPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/gallery");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("shows photos from every drive without asking which one", async () => {
    stubGalleryFetch();
    renderGallery();
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("two.jpg")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });

  it("points people to Drives when there is nothing to look in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/gallery/status")) {
          return new Response(JSON.stringify(STATUS_OK), {
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
    expect(await screen.findByText(/No drives yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Drives/i })).toHaveAttribute("href", "/drives");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Search photos/i)).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot=gallery-toolbar]")).toBeNull();
  });

  it("defaults the URL hash to #library when none is set", async () => {
    stubGalleryFetch();
    renderGallery();
    await screen.findByRole("radio", { name: /^Library$/i });
    await waitFor(() => {
      expect(window.location.hash).toBe("#library");
    });
    expect(screen.getByRole("radio", { name: /^Library$/i })).toHaveAttribute("aria-checked", "true");
  });

  it("slides the album Back + title row in from the left on open", async () => {
    window.history.replaceState(null, "", "/gallery#albums");
    stubGalleryFetch({
      albums: [
        {
          id: "al1",
          home_drive_id: "a",
          name: "test",
          item_count: 0,
          shared: false,
          cover_thumb: null,
        },
      ],
    });
    renderGallery();
    // Prefer the open-album control; /test/i also matches "Delete album test".
    fireEvent.click(await screen.findByRole("button", { name: /^test\b/i }));
    expect(await screen.findByRole("button", { name: /^Back$/i })).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    const chrome = document.querySelector("[data-slot=gallery-detail-chrome]");
    expect(chrome).toBeTruthy();
    expect(chrome?.className).toContain("animate-nav-slide-in");
    expect(chrome?.className).toContain("mb-4");
    expect(chrome?.className).toContain("flex");
  });

  it("shows a centered spinner while albums are still loading", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releaseAlbums;
    const albumsHold = new Promise((resolve) => {
      releaseAlbums = resolve;
    });
    window.history.replaceState(null, "", "/gallery#albums");
    stubGalleryFetch({ albumsHold });
    renderGallery();
    expect(await screen.findByText(/Loading albums/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
    releaseAlbums?.();
    expect(await screen.findByText(/No albums yet/i)).toBeInTheDocument();
  });

  it("shows a centered spinner while the library list is still loading", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releaseGallery;
    const galleryHold = new Promise((resolve) => {
      releaseGallery = resolve;
    });
    stubGalleryFetch({ galleryHold });
    renderGallery();
    expect(await screen.findByText(/Loading library/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect(screen.queryByText(/Looking through your drives/i)).not.toBeInTheDocument();
    releaseGallery?.();
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();
    expect(screen.queryByText(/Loading library/i)).not.toBeInTheDocument();
  });

  it("shows a centered spinner while favorites are still loading", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releaseGallery;
    const galleryHold = new Promise((resolve) => {
      releaseGallery = resolve;
    });
    window.history.replaceState(null, "", "/gallery#favorites");
    stubGalleryFetch({ galleryHold, galleryItems: [] });
    renderGallery();
    expect(await screen.findByText(/Loading favorites/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect(screen.queryByText(/No favorites yet/i)).not.toBeInTheDocument();
    releaseGallery?.();
    expect(await screen.findByText(/No favorites yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading favorites/i)).not.toBeInTheDocument();
  });

  it("opens Places when loaded with #places", async () => {
    window.history.replaceState(null, "", "/gallery#places");
    stubGalleryFetch({
      places: [{ key: "home", label: "Home", count: 2, lat: 1, lon: 2 }],
    });
    renderGallery();
    expect(await screen.findByRole("radio", { name: /^Places$/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(window.location.hash).toBe("#places");
    const page = document.querySelector("[data-slot=page]");
    expect(page?.className).toMatch(/\bflex\b/);
    expect(page?.className).toMatch(/100dvh/);
    expect(page?.className).toMatch(/\boverflow-hidden\b/);
    // Wait for places fetch → map (HeaderCard also uses data-slot=card).
    await waitFor(() => {
      expect(document.querySelector(".places-map")).toBeTruthy();
    });
    const mapCard = document.querySelector(".places-map")?.closest("[data-slot=card]");
    expect(mapCard?.className).toMatch(/\bh-full\b/);
  });

  it("shows a pop-in card while Luna is still finding photos", async () => {
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
        if (u.includes("/gallery/status")) {
          return new Response(
            JSON.stringify({
              scanning: true,
              pending: 3,
              busy: true,
              phase: "scanning",
              drive_id: "a",
              drive_label: "Family",
              found_count: 4,
              last_error: null,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
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
    expect(await screen.findByText(/Looking through your drives/i)).toBeInTheDocument();
    expect(screen.getByText(/as they're found/i)).toBeInTheDocument();
    // Status (found_count / drive_label) can resolve after the Looking card
    // already appears from gallery.isLoading — wait for progress text.
    expect(await screen.findByText(/Found 4 photos on Family/i)).toBeInTheDocument();
    expect(screen.queryByText(/Previews stay on your drive/i)).not.toBeInTheDocument();
    const card = screen.getByText(/Looking through your drives/i).closest("[data-slot=card-clip]");
    expect(card?.className).toMatch(/pop-in/);
  });

  it("shows Places empty state with Card pop-in when there are no geotagged photos", async () => {
    window.history.replaceState(null, "", "/gallery#places");
    stubGalleryFetch({ places: [] });
    renderGallery();
    expect(await screen.findByText(/No places yet/i)).toBeInTheDocument();
    const empty = document.querySelector("[data-slot=empty-state]");
    expect(empty).toBeTruthy();
    const clip = empty?.closest("[data-slot=card-clip]") || empty?.closest("[data-slot=card]");
    expect(clip?.className).toMatch(/pop-in/);
  });

  it("updates the hash when a segment is selected", async () => {
    stubGalleryFetch();
    const user = userEvent.setup();
    renderGallery();
    await screen.findByRole("radio", { name: /^Library$/i });
    await user.click(screen.getByRole("radio", { name: /^Favorites$/i }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#favorites");
    });
    expect(screen.getByRole("radio", { name: /^Favorites$/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("follows hashchange for back/forward navigation", async () => {
    stubGalleryFetch();
    renderGallery();
    await screen.findByRole("radio", { name: /^Library$/i });
    await waitFor(() => {
      expect(window.location.hash).toBe("#library");
    });

    act(() => {
      window.location.hash = "albums";
    });
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /^Albums$/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });

    act(() => {
      window.location.hash = "library";
    });
    await waitFor(() => {
      expect(screen.getByRole("radio", { name: /^Library$/i })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
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
      if (u.includes("/gallery/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
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
        if (u.includes("/gallery/status")) {
          return new Response(JSON.stringify(STATUS_OK), {
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

  it("shows an empty Favorites state even while gallery indexing is busy", async () => {
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
        if (u.includes("/gallery/status")) {
          return new Response(JSON.stringify({ scanning: true, pending: 3, busy: true }), {
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
  });

  it("offers Look again when the library is idle and empty", async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/rescan") && method === "POST") {
        return new Response(JSON.stringify({ ok: true, queued: 1, busy: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
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
    });
    vi.stubGlobal("fetch", fetchMock);
    renderGallery();
    expect(await screen.findByText(/No photos yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Add pictures to a drive/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Look again/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/gallery/rescan") &&
            (init?.method || "GET").toUpperCase() === "POST",
        ),
      ).toBe(true);
    });
  });

  it("refreshes gallery queries once when busy ends", async () => {
    let busy = true;
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/status")) {
        return new Response(
          JSON.stringify({
            scanning: busy,
            pending: busy ? 2 : 0,
            busy,
            phase: busy ? "scanning" : "idle",
            found_count: busy ? 1 : 2,
            drive_id: busy ? "a" : null,
            drive_label: busy ? "Family" : null,
            last_error: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/gallery?")) {
        return new Response(
          JSON.stringify({
            items: busy
              ? []
              : [
                  {
                    drive_id: "a",
                    path: "done.jpg",
                    name: "done.jpg",
                    taken_at: 1_700_000_000,
                    thumb: "/td",
                    kind: "image",
                  },
                ],
            next_offset: 0,
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <GalleryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Looking through your drives/i)).toBeInTheDocument();
    // Wait until indexing status is live so wasIndexingRef is armed; otherwise
    // flipping busy before the first status resolve skips the final refresh.
    expect(await screen.findByText(/Found 1 photo on Family/i)).toBeInTheDocument();
    const galleryCallsWhileBusy = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/gallery?"),
    ).length;

    busy = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["gallery-status"] });
    });

    expect(await screen.findByLabelText("done.jpg")).toBeInTheDocument();
    await waitFor(() => {
      const galleryCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/gallery?"));
      expect(galleryCalls.length).toBeGreaterThan(galleryCallsWhileBusy);
    });
  });

  it("shows a placeholder hint on the New album name field", async () => {
    window.history.replaceState(null, "", "/gallery#albums");
    stubGalleryFetch();
    renderGallery();
    expect(await screen.findByText(/No albums yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /New album/i })[0]);

    expect(await screen.findByRole("heading", { name: "New album" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Album name/i)).toHaveAttribute(
      "placeholder",
      "e.g. Family Trip to Beijing",
    );
  });

  it("renders Add to album modal with search, selection, and outline Cancel", async () => {
    stubGalleryFetch({
      albums: [
        {
          id: "alb1",
          home_drive_id: "a",
          name: "test",
          item_count: 0,
          shared: false,
        },
        {
          id: "alb2",
          home_drive_id: "a",
          name: "Vacation",
          item_count: 2,
          shared: false,
        },
      ],
    });
    renderGallery();
    const photo = await screen.findByLabelText("one.jpg");
    fireEvent.click(photo);

    const addToAlbumBtn = await screen.findByRole("button", { name: /Add to album/i });
    fireEvent.click(addToAlbumBtn);

    expect(await screen.findByRole("heading", { name: "Add to album" })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Search albums/i)).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /test/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Vacation/i })).toBeInTheDocument();

    const addBtn = screen.getByRole("button", { name: /^Add$/i });
    expect(addBtn).toBeDisabled();

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn).toBeInTheDocument();
    expect(cancelBtn.className).toContain("border-2");
    expect(cancelBtn.className).toContain("border-primary");

    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Add to album" })).not.toBeInTheDocument();
    });
  });

  it("adds a photo to the selected album and closes the modal", async () => {
    const albums = [
      {
        id: "alb1",
        home_drive_id: "a",
        name: "test",
        item_count: 0,
        shared: false,
      },
    ];
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/albums/a/alb1/items") && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/albums") && method === "GET") {
        return new Response(JSON.stringify(albums), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery?")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                drive_id: "a",
                path: "one.jpg",
                name: "one.jpg",
                taken_at: 1_700_000_000,
                thumb: "/t1",
                kind: "image",
              },
            ],
            next_offset: 1,
            has_more: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderGallery();
    fireEvent.click(await screen.findByLabelText("one.jpg"));
    fireEvent.click(await screen.findByRole("button", { name: /Add to album/i }));

    expect(await screen.findByRole("heading", { name: "Add to album" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: /test/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Add$/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes("/gallery/albums/a/alb1/items")
          && (init?.method || "GET").toUpperCase() === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post[1].body))).toEqual({
        items: [{ drive_id: "a", path: "one.jpg" }],
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Add to album" })).not.toBeInTheDocument();
    });
  });

  it("shows a delete control on album cards and removes the album after confirm", async () => {
    const album = {
      id: "alb1",
      home_drive_id: "a",
      name: "Vacation",
      item_count: 2,
      shared: false,
    };
    let albumsList = [album];
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/albums/a/alb1") && method === "DELETE") {
        albumsList = [];
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/albums") && method === "GET") {
        return new Response(JSON.stringify(albumsList), {
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
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/gallery#albums");
    const user = userEvent.setup();
    renderGallery();

    expect(await screen.findByText("Vacation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share album" })).toBeInTheDocument();
    const deleteBtn = screen.getByRole("button", { name: "Delete album Vacation" });
    expect(deleteBtn.className).toMatch(/shrink-0/);
    await user.click(deleteBtn);

    expect(await screen.findByRole("heading", { name: "Delete album?" })).toBeInTheDocument();
    expect(
      screen.getByText(/Photos stay in your library — only this album is removed/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Delete album$/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/gallery/albums/a/alb1") &&
            (init?.method || "GET").toUpperCase() === "DELETE",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByText("Vacation")).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/No albums yet/i)).toBeInTheDocument();
  });

  it("keeps the album when delete is cancelled", async () => {
    const album = {
      id: "alb1",
      home_drive_id: "a",
      name: "Keep me",
      item_count: 0,
      shared: false,
    };
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/albums")) {
        return new Response(JSON.stringify([album]), {
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
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/gallery#albums");
    const user = userEvent.setup();
    renderGallery();

    expect(await screen.findByText("Keep me")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete album Keep me" }));
    expect(await screen.findByRole("heading", { name: "Delete album?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Delete album?" })).not.toBeInTheDocument();
    });
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every((call) => {
        /** @type {any} */
        const c = call;
        return ((c[1]?.method) || "GET").toUpperCase() !== "DELETE";
      }),
    ).toBe(true);
  });

  it("opens ShareAlbumModal when clicking Share album", async () => {
    const album = {
      id: "alb-share",
      home_drive_id: "a",
      name: "Shared Moments",
      item_count: 5,
      shared: true,
      cover_thumb: "/thumb",
    };
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Drive A" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/gallery/albums/a/alb-share/invites")) {
        return new Response(
          JSON.stringify([
            {
              id: "inv-1",
              album_id: "alb-share",
              token: "tok123",
              url: "/a/tok123",
              role: "contributor",
              expires_at: null,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/gallery/albums")) {
        return new Response(JSON.stringify([album]), {
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
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/gallery#albums");
    const user = userEvent.setup();
    renderGallery();

    expect(await screen.findByText("Shared Moments")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Share album" }));

    expect(await screen.findByRole("heading", { name: 'Share "Shared Moments"' })).toBeInTheDocument();
    expect(screen.getByText("Create a link")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate link/i })).toBeInTheDocument();
    expect(await screen.findByText("Can view & add")).toBeInTheDocument();
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import { FileOpsProvider } from "../context/FileOpsContext.jsx";
import PhotosPage, {
  downloadErrorMessage,
  downloadFailureDescription,
  PhotosDownloadError,
  photosUrl,
  openDownloadFile,
  parsePhotosHash,
  saveDownloadResponse,
  cancelDownloadResponse,
} from "./PhotosPage";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";

const STATUS_OK = { scanning: false, pending: 0, busy: false };

/**
 * @param {{
 *   places?: unknown[],
 *   albums?: unknown[],
 *   albumsHold?: Promise<void>,
 *   photosHold?: Promise<void>,
 *   photosItems?: unknown[] | null,
 *   role?: string,
 *   drives?: unknown[] | null,
 * }} [options]
 */
function stubPhotosFetch({
  places = [],
  albums = [],
  albumsHold,
  photosHold,
  photosItems,
  role = "admin",
  drives = [
    { id: "a", label: "Family" },
    { id: "b", label: "Travel" },
  ],
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/auth/me") || u.endsWith("/auth/status")) {
        return new Response(
          JSON.stringify({
            id: "1",
            username: role === "admin" ? "max" : "jamie",
            role,
            has_admin: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/setup")) {
        return new Response(
          JSON.stringify({ name: "Luna", setup_completed: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify(drives ?? []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/places")) {
        return new Response(JSON.stringify(places), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/members") || u.includes("/invites")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/albums")) {
        if (albumsHold) await albumsHold;
        return new Response(JSON.stringify(albums), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos")) {
        if (photosHold) await photosHold;
        const items =
          photosItems !== undefined
            ? photosItems
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

/**
 * Uploads go over XHR (progress), not fetch. A fake that records every open()
 * and answers success, so the drop only has to reach the upload queue.
 * @returns {Array<[string, string]>} the recorded [method, url] pairs
 */
function stubUploadXhr() {
  const opens = [];
  class FakeXhr {
    constructor() {
      /** @type {any} */
      this.upload = {};
      this.onload = null;
      this.onerror = null;
      this.status = 200;
      this.responseText = "{}";
    }
    /** @param {string} method @param {string} url */
    open(method, url) {
      opens.push([method, String(url)]);
    }
    setRequestHeader() {}
    send() {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return opens;
}

function renderPhotos({ withShortcuts = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
    <QueryClientProvider client={client}>
      <FileOpsProvider>
      <MemoryRouter>
        <AuthProvider>
          {withShortcuts ? (
            <ShortcutsProvider>
              <PhotosPage />
            </ShortcutsProvider>
          ) : (
            <PhotosPage />
          )}
        </AuthProvider>
      </MemoryRouter>
      </FileOpsProvider>
    </QueryClientProvider>
    </ToastProvider>,
  );
}

describe("PhotosPage photo upload", () => {
  it("sends a dropped photo through the file operation store", async () => {
    stubPhotosFetch({ drives: [{ id: "a", label: "Family", state: "as_is", mount_point: "/mnt/a" }] });
    const opens = stubUploadXhr();
    renderPhotos();
    await screen.findByRole("button", { name: /rescan/i }).catch(() => null);
    const photo = new File(["x"], "beach.jpg", { type: "image/jpeg" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { files: [photo] } });
    await act(async () => {
      // The page listens on its drop zone; dropping on a child bubbles up to it.
      screen.getByLabelText("Search photos").dispatchEvent(drop);
    });
    await waitFor(() => {
      expect(opens.some(([method, url]) => method !== "GET" && /upload/.test(String(url)))).toBe(true);
    });
  });
});

describe("photosUrl", () => {
  it("asks for favorites with true/false that lunad can parse", () => {
    expect(photosUrl({ favorites: true, offset: 0 })).toContain("favorites=true");
    expect(photosUrl({ favorites: true, offset: 0 })).not.toMatch(/favorites=1(?:&|$)/);
    expect(photosUrl({ favorites: false, offset: 0 })).not.toContain("favorites=");
  });

  it("wires day bounds as from/to unix seconds", () => {
    const url = photosUrl({ from: 1700000000, to: 1700086399, offset: 0 });
    expect(url).toContain("from=1700000000");
    expect(url).toContain("to=1700086399");
  });

  it("asks for a kind filter", () => {
    expect(photosUrl({ kind: "video" })).toContain("kind=video");
  });

  it("includes camera_make and place_bbox when set", () => {
    const url = photosUrl({
      cameraMake: "Canon",
      cameraModel: "EOS R5",
      placeBbox: "-10,20,-5,30",
    });
    expect(url).toContain("camera_make=Canon");
    expect(url).toContain("camera_model=EOS");
    expect(url).toContain("place_bbox=-10%2C20%2C-5%2C30");
  });

  it("wires undated and album_membership", () => {
    expect(photosUrl({ undated: true })).toContain("undated=true");
    expect(photosUrl({ albumMembership: "none" })).toContain("album_membership=none");
    expect(photosUrl({ albumMembership: "any" })).toContain("album_membership=any");
    expect(photosUrl({ albumMembership: "maybe" })).not.toContain("album_membership=");
  });

  it("wires month_day and a custom page size for the On this day view", () => {
    const url = photosUrl({ monthDay: "03-14", to: 1700000000, limit: 80 });
    expect(url).toContain("month_day=03-14");
    expect(url).toContain("to=1700000000");
    expect(url).toContain("limit=80");
    expect(photosUrl({ limit: 1 })).toContain("limit=1");
  });
});

describe("parsePhotosHash", () => {
  it("parses day deep links", () => {
    expect(parsePhotosHash("#day/2024-06-01")).toEqual({
      segment: "library",
      day: "2024-06-01",
    });
  });

  it("parses scroll and photo params on the library", () => {
    const p = `${encodeURIComponent("a")}|${encodeURIComponent("dir/one.jpg")}`;
    expect(parsePhotosHash(`#library?y=2400&p=${p}`)).toEqual({
      segment: "library",
      y: 2400,
      photo: "a\0dir/one.jpg",
    });
  });

  it("keeps params on album deep links", () => {
    const p = `${encodeURIComponent("a")}|${encodeURIComponent("x.jpg")}`;
    expect(parsePhotosHash(`#albums/a/al1?p=${p}`)).toEqual({
      segment: "albums",
      albumHome: "a",
      albumId: "al1",
      photo: "a\0x.jpg",
    });
  });

  it("parses the On this day deep link", () => {
    expect(parsePhotosHash("#onthisday")).toEqual({
      segment: "library",
      onThisDay: true,
    });
  });
});

describe("PhotosPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/photos");
  });

  describe("saveDownloadResponse", () => {
    it("writes the response as it arrives when file streaming is supported", async () => {
      const writes = [];
      const close = vi.fn();
      vi.stubGlobal("showSaveFilePicker", vi.fn(async (options) => {
        expect(options.suggestedName).toBe("photos.zip");
        return {
          createWritable: async () => ({
            write: async (chunk) => writes.push(chunk),
            close,
            abort: vi.fn(),
          }),
        };
      }));

      const writable = await openDownloadFile("photos.zip");
      await saveDownloadResponse(new Response("zip contents"), "photos.zip", writable);

      expect(new TextDecoder().decode(writes[0])).toBe("zip contents");
      expect(close).toHaveBeenCalledOnce();
    });

    it("stops reading and aborts the file when writing fails", async () => {
      const failure = new DOMException("Disk full", "QuotaExceededError");
      const cancel = vi.fn().mockResolvedValue(undefined);
      const abort = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn();
      const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
        cancel,
      }));
      vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({
        createWritable: async () => ({ write: vi.fn().mockRejectedValue(failure), abort, close }),
      })));
      const writable = await openDownloadFile("photos.zip");

      await expect(saveDownloadResponse(response, "photos.zip", writable)).rejects.toBe(failure);
      expect(cancel).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe("downloadErrorMessage", () => {
    it("keeps the server's plain-language error", async () => {
      const message = await downloadErrorMessage(
        new Response(JSON.stringify({ error: "Select fewer photos and try again." }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(message).toBe("Select fewer photos and try again.");
    });

    it("names a failed download when the response is not JSON", async () => {
      const message = await downloadErrorMessage(new Response("offline", { status: 503 }));
      expect(message).toBe("Luna couldn't prepare that download. Try again.");
    });
  });

  describe("cancelDownloadResponse", () => {
    it("cancels a response body when its download cannot be used", async () => {
      const cancel = vi.fn();
      await cancelDownloadResponse({ body: { cancel } });
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  describe("downloadFailureDescription", () => {
    it("keeps server errors regardless of their wording", () => {
      const message = "You don't have permission to download one of these photos.";
      expect(downloadFailureDescription(new PhotosDownloadError(message))).toBe(message);
    });

    it("names the chosen save location when it runs out of space", () => {
      expect(downloadFailureDescription(new DOMException("Full", "QuotaExceededError")))
        .toBe("This device couldn't save the file. Make sure the chosen save location has enough space.");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("retries the failed next page instead of refetching loaded pages when a date jump fails", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    stubPhotosFetch();
    const baseFetch = globalThis.fetch;
    let failNextPage = true;
    const fetchMock = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.startsWith("/api/v1/photos?")) {
        const offset = Number(new URL(u, "http://luna.local").searchParams.get("offset"));
        if (offset === 0) {
          return new Response(JSON.stringify({
            items: [{
              drive_id: "a", path: "recent.jpg", name: "recent.jpg",
              taken_at: 1_700_000_000, thumb: "/t1", kind: "image",
            }],
            next_offset: 1, has_more: true,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (failNextPage) return new Response("", { status: 500 });
        return new Response(JSON.stringify({
          items: [{
            drive_id: "a", path: "older.jpg", name: "older.jpg",
            taken_at: 946_684_800, thumb: "/t0", kind: "image",
          }],
          next_offset: offset + 1, has_more: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return baseFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPhotos();

    await screen.findByLabelText("recent.jpg");
    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Jump to a day" }));
    fireEvent.change(screen.getByLabelText("Day to jump to"), {
      target: { value: "2020-01-01" },
    });

    expect(await screen.findByText("Luna couldn't open Photos. Try again.")).toBeInTheDocument();
    const offsetZeroCalls = () => fetchMock.mock.calls.filter(([url]) => {
      const u = String(url);
      return u.startsWith("/api/v1/photos?")
        && new URL(u, "http://luna.local").searchParams.get("offset") === "0";
    }).length;
    const beforeRetry = offsetZeroCalls();

    failNextPage = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("older.jpg")).toBeInTheDocument();
    expect(offsetZeroCalls()).toBe(beforeRetry);
  });

  it("retries the failed next page instead of refetching loaded pages when a date jump loses the connection", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    stubPhotosFetch();
    const baseFetch = globalThis.fetch;
    let failNextPage = true;
    const fetchMock = vi.fn(async (url, init) => {
      const u = String(url);
      if (u.startsWith("/api/v1/photos?")) {
        const offset = Number(new URL(u, "http://luna.local").searchParams.get("offset"));
        if (offset === 0) {
          return new Response(JSON.stringify({
            items: [{
              drive_id: "a", path: "recent.jpg", name: "recent.jpg",
              taken_at: 1_700_000_000, thumb: "/t1", kind: "image",
            }],
            next_offset: 1, has_more: true,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (failNextPage) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({
          items: [{
            drive_id: "a", path: "older.jpg", name: "older.jpg",
            taken_at: 946_684_800, thumb: "/t0", kind: "image",
          }],
          next_offset: offset + 1, has_more: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return baseFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPhotos();

    await screen.findByLabelText("recent.jpg");
    await user.click(screen.getByRole("button", { name: "More options" }));
    await user.click(await screen.findByRole("menuitem", { name: "Jump to a day" }));
    fireEvent.change(screen.getByLabelText("Day to jump to"), {
      target: { value: "2020-01-01" },
    });

    expect(await screen.findByText("Couldn't reach Luna")).toBeInTheDocument();
    const offsetZeroCalls = () => fetchMock.mock.calls.filter(([url]) => {
      const u = String(url);
      return u.startsWith("/api/v1/photos?")
        && new URL(u, "http://luna.local").searchParams.get("offset") === "0";
    }).length;
    const beforeRetry = offsetZeroCalls();

    failNextPage = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("older.jpg")).toBeInTheDocument();
    expect(offsetZeroCalls()).toBe(beforeRetry);
  });

  it("shows photos from every drive without asking which one", async () => {
    stubPhotosFetch();
    renderPhotos();
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("two.jpg")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });

  it("points Admins to Files when there is nothing to look in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/auth/me") || u.endsWith("/auth/status")) {
          return new Response(
            JSON.stringify({ id: "1", username: "max", role: "admin", has_admin: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.includes("/setup")) {
          return new Response(
            JSON.stringify({ name: "Luna", setup_completed: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.includes("/photos/status")) {
          return new Response(JSON.stringify(STATUS_OK), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/photos?")) {
          return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderPhotos();
    expect(await screen.findByText(/No drives yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Files/i })).toHaveAttribute("href", "/files");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Search photos/i)).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot=photos-toolbar]")).toBeNull();
  });

  it("tells Members to ask an Admin when they have no drives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/auth/me") || u.endsWith("/auth/status")) {
          return new Response(
            JSON.stringify({ id: "2", username: "jamie", role: "user", has_admin: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.includes("/setup")) {
          return new Response(
            JSON.stringify({ name: "Luna", setup_completed: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.includes("/photos/status")) {
          return new Response(JSON.stringify(STATUS_OK), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderPhotos();
    expect(await screen.findByText(/No photos you can open yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Ask an Admin to share a drive, folder, or album with photos/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Go to Files/i })).not.toBeInTheDocument();
  });

  it("lets album-only Members open Albums when they have no drives", async () => {
    stubPhotosFetch({
      role: "user",
      drives: [],
      photosItems: [],
      albums: [
        {
          id: "al-shared",
          home_drive_id: "a",
          name: "Family trip",
          item_count: 3,
          shared: true,
          cover_thumb: null,
        },
      ],
    });
    renderPhotos();
    expect(await screen.findByText(/Shared photos are in Albums/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open albums/i }));
    expect(await screen.findByRole("button", { name: /^Family trip\b/i })).toBeInTheDocument();
    expect(screen.queryByText(/No photos you can open yet/i)).not.toBeInTheDocument();
  });

  it("focuses the photo search when / is pressed", async () => {
    stubPhotosFetch();
    renderPhotos({ withShortcuts: true });
    await screen.findByLabelText("one.jpg");
    const input = screen.getByLabelText("Search photos");
    expect(input).not.toHaveFocus();
    await userEvent.keyboard("/");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("");
  });

  it("defaults the URL hash to #library when none is set", async () => {
    stubPhotosFetch();
    renderPhotos();
    await screen.findByRole("radio", { name: /^Library$/i });
    await waitFor(() => {
      expect(window.location.hash).toBe("#library");
    });
    expect(screen.getByRole("radio", { name: /^Library$/i })).toHaveAttribute("aria-checked", "true");
  });

  it("slides the album Back + title row in from the left on open", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch({
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
    renderPhotos();
    // Prefer the open-album control; /test/i also matches "Delete album test".
    fireEvent.click(await screen.findByRole("button", { name: /^test\b/i }));
    expect(await screen.findByRole("button", { name: /^Back$/i })).toBeInTheDocument();
    const chrome = document.querySelector("[data-slot=photos-detail-chrome]");
    expect(chrome).toBeTruthy();
    expect(within(/** @type {HTMLElement} */ (chrome)).getByText("test")).toBeInTheDocument();
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
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch({ albumsHold });
    renderPhotos();
    expect(await screen.findByText(/Loading albums/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
    releaseAlbums?.();
    expect(await screen.findByText(/No albums yet/i)).toBeInTheDocument();
  });

  it("shows a centered spinner while the library list is still loading", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releasePhotos;
    const photosHold = new Promise((resolve) => {
      releasePhotos = resolve;
    });
    stubPhotosFetch({ photosHold });
    renderPhotos();
    expect(await screen.findByText(/Loading library/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect(screen.queryByText(/Looking through your drives/i)).not.toBeInTheDocument();
    releasePhotos?.();
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();
    expect(screen.queryByText(/Loading library/i)).not.toBeInTheDocument();
  });

  it("shows a centered spinner while favorites are still loading", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releasePhotos;
    const photosHold = new Promise((resolve) => {
      releasePhotos = resolve;
    });
    window.history.replaceState(null, "", "/photos#favorites");
    stubPhotosFetch({ photosHold, photosItems: [] });
    renderPhotos();
    expect(await screen.findByText(/Loading favorites/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy();
    expect(screen.queryByText(/No favorites yet/i)).not.toBeInTheDocument();
    releasePhotos?.();
    expect(await screen.findByText(/No favorites yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Loading favorites/i)).not.toBeInTheDocument();
  });

  it("opens Places when loaded with #places", async () => {
    window.history.replaceState(null, "", "/photos#places");
    stubPhotosFetch({
      places: [{ key: "home", label: "Home", count: 2, lat: 1, lon: 2 }],
    });
    renderPhotos();
    expect(await screen.findByRole("radio", { name: /^Places$/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(window.location.hash).toBe("#places");
    const page = document.querySelector("[data-slot=page]");
    expect(page?.className).toMatch(/\bflex\b/);
    expect(page?.className).toMatch(/100dvh/);
    expect(page?.className).toMatch(/\boverflow-hidden\b/);
    expect(page?.className).toMatch(/\bpb-6\b/);
    expect(page?.className).toMatch(/xl:pb-\[108px\]/);
    // Wait for places fetch → map (HeaderCard also uses data-slot=card).
    await waitFor(() => {
      expect(document.querySelector(".places-map")).toBeTruthy();
    });
    const mapCard = document.querySelector(".places-map")?.closest("[data-slot=card]");
    expect(mapCard?.className).toMatch(/\bflex-1\b/);
    expect(mapCard?.className).toMatch(/\bmin-h-0\b/);
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
        if (u.includes("/photos/status")) {
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
        if (u.includes("/photos?")) {
          return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderPhotos();
    expect(await screen.findByText(/Looking through your drives/i)).toBeInTheDocument();
    expect(screen.getByText(/as they're found/i)).toBeInTheDocument();
    // Status (found_count / drive_label) can resolve after the Looking card
    // already appears from photoQuery.isLoading — wait for progress text.
    expect(await screen.findByText(/Found 4 photos on Family/i)).toBeInTheDocument();
    expect(screen.queryByText(/Previews stay on your drive/i)).not.toBeInTheDocument();
    const card = screen.getByText(/Looking through your drives/i).closest("[data-slot=card-clip]");
    expect(card?.className).toMatch(/pop-in/);
  });

  it("shows Places empty state entering like the other segments when there are no geotagged photos", async () => {
    window.history.replaceState(null, "", "/photos#places");
    stubPhotosFetch({ places: [] });
    renderPhotos();
    expect(await screen.findByText(/No places yet/i)).toBeInTheDocument();
    const empty = document.querySelector("[data-slot=empty-state]");
    expect(empty).toBeTruthy();
    const clip = empty?.closest("[data-slot=card-clip]") || empty?.closest("[data-slot=card]");
    // Mounts after the segment slide, so it cascades in like the rest, not Card's pop-in.
    expect(clip?.className).toMatch(/animate-cascade-in/);
    expect(clip?.className).not.toMatch(/\bpop-in\b/);
  });

  it("updates the hash when a segment is selected", async () => {
    stubPhotosFetch();
    const user = userEvent.setup();
    renderPhotos();
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

  it("reopens the lightbox photo from the hash on reload", async () => {
    const p = `${encodeURIComponent("b")}|${encodeURIComponent("two.jpg")}`;
    window.history.replaceState(null, "", `/photos#library?p=${p}`);
    stubPhotosFetch();
    renderPhotos();
    expect(await screen.findByRole("dialog", { name: "two.jpg" })).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe(`#library?p=${p}`);
    });
  });

  it("follows hashchange for back/forward navigation", async () => {
    stubPhotosFetch();
    renderPhotos();
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

  it("returns to the albums grid on browser Back and reopens the album on Forward", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch({
      albums: [{ id: "al1", home_drive_id: "a", name: "Trip", item_count: 2 }],
    });
    renderPhotos();

    // Open the album — the hash deep-link pushes a history entry.
    fireEvent.click(await screen.findByRole("button", { name: /^Trip/ }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#albums/a/al1");
    });
    const chrome = document.querySelector("[data-slot=photos-detail-chrome]");
    expect(within(/** @type {HTMLElement} */ (chrome)).getByText("Trip")).toBeInTheDocument();

    // Browser Back lands on the albums grid, not wherever we were before Albums.
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(window.location.hash).toBe("#albums");
    });
    expect(await screen.findByRole("button", { name: /^Trip/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Back$/i })).not.toBeInTheDocument());

    // Forward reopens the same album.
    act(() => {
      window.history.forward();
    });
    await waitFor(() => {
      expect(window.location.hash).toBe("#albums/a/al1");
    });
    const chrome2 = await screen.findByText("Trip");
    expect(chrome2.closest("[data-slot=photos-detail-chrome]")).toBeTruthy();

    // The detail chrome's Back button pops the pushed entry too.
    fireEvent.click(screen.getByRole("button", { name: /^Back$/i }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#albums");
    });
    expect(await screen.findByRole("button", { name: /^Trip/ })).toBeInTheDocument();
  });

  it("opens the share sheet from the album's Share button, which reads just Share", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch({
      albums: [{ id: "al1", home_drive_id: "a", name: "Trip", item_count: 2 }],
    });
    const user = userEvent.setup();
    renderPhotos();

    await user.click(await screen.findByRole("button", { name: /^Trip/ }));
    await waitFor(() => {
      expect(window.location.hash).toBe("#albums/a/al1");
    });

    const chrome = /** @type {HTMLElement} */ (
      document.querySelector("[data-slot=photos-detail-chrome]")
    );
    const share = within(chrome).getByRole("button", { name: "Share album" });
    // Visible label is just "Share"; the album name is not repeated in the
    // accessible name because this bar holds one album only.
    expect(share).toHaveTextContent(/^Share$/);
    expect(within(chrome).queryByRole("button", { name: "Share" })).toBeNull();

    await user.click(share);
    expect(await screen.findByRole("heading", { name: "Sharing" })).toBeInTheDocument();
  });

  it("steps back out of a day view to the full library", async () => {
    window.history.replaceState(null, "", "/photos#library");
    stubPhotosFetch();
    renderPhotos();
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();

    // Clicking a day header scopes the timeline and pushes a history entry.
    const dayBtn = document.querySelector("button[id^='day-']");
    expect(dayBtn).toBeTruthy();
    fireEvent.click(/** @type {HTMLElement} */ (dayBtn));
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#day\//);
    });
    expect(window.history.state?.lunaPhotosDetail).toBe(true);
    expect(await screen.findByRole("button", { name: /^Back$/i })).toBeInTheDocument();

    // Browser Back clears the day scope, returning to the whole library.
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(window.location.hash).toBe("#library");
    });
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("two.jpg")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Back$/i })).not.toBeInTheDocument());
  });

  it("closes the lightbox on browser Back and reopens it on Forward", async () => {
    window.history.replaceState(null, "", "/photos#library");
    stubPhotosFetch();
    renderPhotos();
    fireEvent.click(await screen.findByLabelText("one.jpg"));

    // The open photo is a pushed `?p=` entry.
    await waitFor(() => {
      expect(window.location.hash).toContain("p=");
    });
    expect(await screen.findByRole("dialog", { name: "one.jpg" })).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);

    // Back closes the lightbox but stays on the library.
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.hash).toBe("#library");
    expect(screen.getByLabelText("one.jpg")).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);

    // Forward reopens the same photo.
    act(() => {
      window.history.forward();
    });
    expect(await screen.findByRole("dialog", { name: "one.jpg" })).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);
  });

  it("releases scroll lock when exiting lightbox on scrolled timeline via browser Back", async () => {
    Object.defineProperty(document.documentElement, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    window.history.replaceState(null, "", "/photos#library?y=350");
    stubPhotosFetch();
    renderPhotos();
    fireEvent.click(await screen.findByLabelText("one.jpg"));

    await waitFor(() => {
      expect(window.location.hash).toContain("p=");
    });
    expect(await screen.findByRole("dialog", { name: "one.jpg" })).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.hash).toBe("#library?y=350");
    expect(screen.getByLabelText("one.jpg")).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
  });

  it("releases scroll lock when exiting lightbox on scrolled timeline via Close button", async () => {
    Object.defineProperty(document.documentElement, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    window.history.replaceState(null, "", "/photos#library?y=350");
    stubPhotosFetch();
    renderPhotos();
    fireEvent.click(await screen.findByLabelText("one.jpg"));

    await waitFor(() => {
      expect(window.location.hash).toContain("p=");
    });
    expect(await screen.findByRole("dialog", { name: "one.jpg" })).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);

    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.hash).toBe("#library?y=350");
    expect(screen.getByLabelText("one.jpg")).toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
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
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos?")) {
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
    renderPhotos();
    expect(await screen.findByLabelText("other.jpg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Favorites/i }));

    expect(await screen.findByLabelText("fav.jpg")).toBeInTheDocument();
    // The outgoing page animates out, so wait for it to leave the DOM.
    await waitFor(() => expect(screen.queryByLabelText("other.jpg")).not.toBeInTheDocument());
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
        if (u.includes("/photos/status")) {
          return new Response(JSON.stringify(STATUS_OK), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/photos?")) {
          return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderPhotos();
    fireEvent.click(await screen.findByRole("radio", { name: /Favorites/i }));
    expect(await screen.findByText(/No favorites yet/i)).toBeInTheDocument();
    expect(screen.getByText(/tap the heart/i)).toBeInTheDocument();
  });

  it("shows one empty state when search and filters both match nothing", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch({ photosItems: [] });
    renderPhotos();
    // Smart album "Videos" applies the kind=video filter inside Albums.
    fireEvent.click(await screen.findByRole("button", { name: /Smart albums/i }));
    fireEvent.click(await screen.findByRole("option", { name: /^Videos$/i }));
    const noMatch = await screen.findByText(/No photos match these filters/i);
    // The Back chrome sits above the empty state, not under it.
    const chrome = document.querySelector("[data-slot=photos-detail-chrome]");
    const emptyStateEl = noMatch.closest("[data-slot=empty-state]");
    expect(chrome).toBeTruthy();
    expect(emptyStateEl).toBeTruthy();
    expect(
      /** @type {HTMLElement} */ (chrome).compareDocumentPosition(
        /** @type {Element} */ (emptyStateEl),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    fireEvent.change(screen.getByLabelText(/Search photos/i), { target: { value: "fuji" } });

    const card = await screen.findByText(/with these filters on/i);
    // The outgoing page animates out; wait for it to leave the DOM.
    await waitFor(() => {
      expect(screen.queryByText(/No photos match these filters/i)).not.toBeInTheDocument();
      expect(document.querySelectorAll("[data-slot=empty-state]")).toHaveLength(1);
    });
    const emptyState = /** @type {HTMLElement} */ (card.closest("[data-slot=empty-state]"));
    expect(within(emptyState).getByRole("button", { name: /^Clear search$/i })).toBeInTheDocument();

    // Clearing the filters also clears the search, so the combined empty
    // state goes away and the normal grid (with its own empty state) returns.
    fireEvent.click(within(emptyState).getByRole("button", { name: /^Clear filters$/i }));
    await waitFor(() => {
      expect(screen.queryByText(/with these filters on/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Try another word or clear the search/i)).not.toBeInTheDocument();
    });
    // The normal grid really came back, not just an empty page: this test
    // starts in Albums, whose own empty state is the positive assertion.
    expect(await screen.findByText(/No albums yet/i)).toBeInTheDocument();
  });

  it("keeps a smart album inside Albums, can save it as an album, and Back returns to the grid", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch();
    renderPhotos();

    fireEvent.click(await screen.findByRole("button", { name: /Smart albums/i }));
    fireEvent.click(await screen.findByRole("option", { name: /^Videos$/i }));

    // The Albums segment stays selected and the smart view gets its own chrome.
    expect(await screen.findByRole("button", { name: /^Back$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Albums$/i })).toHaveAttribute("aria-checked", "true");
    const chrome = document.querySelector("[data-slot=photos-detail-chrome]");
    expect(chrome).toBeTruthy();
    expect(within(/** @type {HTMLElement} */ (chrome)).getByText("Videos")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        vi.mocked(globalThis.fetch).mock.calls.some(([url]) =>
          String(url).includes("kind=video"),
        ),
      ).toBe(true);
    });

    // Save as album opens the New album modal seeded with the shown photos.
    fireEvent.click(
      within(/** @type {HTMLElement} */ (chrome)).getByRole("button", { name: /Save as album/i }),
    );
    const nameInput = await screen.findByLabelText(/Album name/i);
    expect(nameInput).toHaveValue("Videos");
    expect(screen.getByText(/Adds 2 selected photos/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Create$/i }));
    await waitFor(() => {
      expect(
        vi.mocked(globalThis.fetch).mock.calls.some(
          ([url, init]) =>
            String(url).includes("/photos/albums") &&
            (init?.method || "GET").toUpperCase() === "POST",
        ),
      ).toBe(true);
    });

    // Back returns to the albums grid, not the library.
    fireEvent.click(await screen.findByRole("button", { name: /^Back$/i }));
    expect(await screen.findByRole("button", { name: /Smart albums/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Albums$/i })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.queryByText("Videos")).not.toBeInTheDocument());
  });

  it("shows only the search empty state when a Favorites search matches nothing", async () => {
    stubPhotosFetch({ photosItems: [] });
    renderPhotos();
    fireEvent.click(await screen.findByRole("radio", { name: /Favorites/i }));
    expect(await screen.findByText(/No favorites yet/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Search photos/i), { target: { value: "fuji" } });

    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.queryByText(/No favorites yet/i)).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll("[data-slot=empty-state]")).toHaveLength(1));
  });

  it("names the album when a search inside it matches nothing", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch({
      photosItems: [],
      albums: [
        {
          id: "al1",
          home_drive_id: "a",
          name: "Trips",
          item_count: 0,
          shared: false,
          cover_thumb: null,
        },
      ],
    });
    renderPhotos();
    fireEvent.click(await screen.findByRole("button", { name: /^Trips\b/i }));
    expect(await screen.findByText(/This album is empty/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Search photos/i), { target: { value: "fuji" } });

    expect(await screen.findByText(/in this album/i)).toBeInTheDocument();
    expect(screen.queryByText(/This album is empty/i)).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll("[data-slot=empty-state]")).toHaveLength(1));
  });

  it("stays inside a real album when Clear filters is pressed on a no-match", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch({
      photosItems: [
        { drive_id: "a", path: "one.jpg", name: "one.jpg", taken_at: 1_700_000_000, thumb: "/t1", kind: "image" },
      ],
      albums: [
        { id: "al1", home_drive_id: "a", name: "Trips", item_count: 1, shared: false, cover_thumb: null },
      ],
    });
    // The shared stub ignores query params; make "fuji" genuinely match
    // nothing so the album's no-results state can be exercised.
    const baseFetch = /** @type {typeof fetch} */ (globalThis.fetch);
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes("/photos?") && u.includes("q=fuji")) {
        return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return baseFetch(url, init);
    }));
    renderPhotos();
    fireEvent.click(await screen.findByRole("button", { name: /^Trips\b/i }));
    expect(await screen.findByRole("button", { name: /^Back$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Filters$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Undated$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Apply$/i }));
    fireEvent.change(screen.getByLabelText(/Search photos/i), { target: { value: "fuji" } });
    const noMatch = await screen.findByText(/in this album/i);
    const emptyState = /** @type {HTMLElement} */ (noMatch.closest("[data-slot=empty-state]"));
    fireEvent.click(within(emptyState).getByRole("button", { name: /^Clear filters$/i }));

    // The real album stays open with its photo; only filters and search clear.
    expect(await screen.findByRole("button", { name: /^Back$/i })).toBeInTheDocument();
    expect(await screen.findByLabelText(/one\.jpg/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=photos-detail-chrome]")).toBeTruthy();
    expect(screen.queryByText(/in this album/i)).not.toBeInTheDocument();
  });

  it("shows an empty Favorites state even while photos indexing is busy", async () => {
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
        if (u.includes("/photos/status")) {
          return new Response(JSON.stringify({ scanning: true, pending: 3, busy: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/photos?")) {
          return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    renderPhotos();
    fireEvent.click(await screen.findByRole("radio", { name: /Favorites/i }));
    expect(await screen.findByText(/No favorites yet/i)).toBeInTheDocument();
  });

  it("offers Rescan drives when the library is idle and empty", async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      if (u.includes("/auth/me") || u.endsWith("/auth/status")) {
        return new Response(JSON.stringify({ id: "1", username: "max", role: "admin", has_admin: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/rescan") && method === "POST") {
        return new Response(JSON.stringify({ ok: true, queued: 1, busy: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos?")) {
        return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPhotos();
    expect(await screen.findByText(/No photos yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Add pictures to a drive/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Rescan drives/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/photos/rescan") &&
            (init?.method || "GET").toUpperCase() === "POST",
        ),
      ).toBe(true);
    });
  });

  it("refreshes photos queries once when busy ends", async () => {
    let busy = true;
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/auth/me") || u.endsWith("/auth/status")) {
        return new Response(
          JSON.stringify({ id: "1", username: "max", role: "admin", has_admin: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/setup")) {
        return new Response(
          JSON.stringify({ name: "Luna", setup_completed: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/status")) {
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
      if (u.includes("/photos?")) {
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
      <ToastProvider>
      <QueryClientProvider client={client}>
        <FileOpsProvider>
        <MemoryRouter>
          <AuthProvider>
            <PhotosPage />
          </AuthProvider>
        </MemoryRouter>
        </FileOpsProvider>
      </QueryClientProvider>
      </ToastProvider>,
    );
    expect(await screen.findByText(/Looking through your drives/i)).toBeInTheDocument();
    // Wait until indexing status is live so wasIndexingRef is armed; otherwise
    // flipping busy before the first status resolve skips the final refresh.
    expect(await screen.findByText(/Found 1 photo on Family/i)).toBeInTheDocument();
    const photosCallsWhileBusy = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/photos?"),
    ).length;

    busy = false;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["photos-status"] });
    });

    expect(await screen.findByLabelText("done.jpg")).toBeInTheDocument();
    await waitFor(() => {
      const photosCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/photos?"));
      expect(photosCalls.length).toBeGreaterThan(photosCallsWhileBusy);
    });
  });

  it("shows a placeholder hint on the New album name field", async () => {
    window.history.replaceState(null, "", "/photos#albums");
    stubPhotosFetch();
    renderPhotos();
    expect(await screen.findByText(/No albums yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /New album/i })[0]);

    expect(await screen.findByRole("heading", { name: "New album" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Album name/i)).toHaveAttribute(
      "placeholder",
      "e.g. Family Trip to Beijing",
    );
  });

  it("renders Add to album modal with search, selection, and outline Cancel", async () => {
    stubPhotosFetch({
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
    renderPhotos();
    const photo = await screen.findByLabelText("one.jpg");
    fireEvent.click(photo);

    const addToAlbumBtn = await screen.findByRole("button", { name: /Add to album/i });
    fireEvent.click(addToAlbumBtn);

    expect(await screen.findByRole("heading", { name: "Add to album" })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Search albums/i)).toBeInTheDocument();
    expect(await screen.findByRole("checkbox", { name: /test/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Vacation/i })).toBeInTheDocument();

    const applyBtn = screen.getByRole("button", { name: /^Apply$/i });
    expect(applyBtn).toBeDisabled();

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
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/albums/a/alb1/items") && method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/albums") && method === "GET") {
        return new Response(JSON.stringify(albums), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos?")) {
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

    renderPhotos();
    fireEvent.click(await screen.findByLabelText("one.jpg"));
    fireEvent.click(await screen.findByRole("button", { name: /Add to album/i }));

    expect(await screen.findByRole("heading", { name: "Add to album" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("checkbox", { name: /test/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes("/photos/albums/a/alb1/items")
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
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/albums/a/alb1") && method === "DELETE") {
        albumsList = [];
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/albums") && method === "GET") {
        return new Response(JSON.stringify(albumsList), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos?")) {
        return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/photos#albums");
    const user = userEvent.setup();
    renderPhotos();

    expect(await screen.findByText("Vacation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share album Vacation" })).toBeInTheDocument();
    const deleteBtn = screen.getByRole("button", { name: "Delete album Vacation" });
    expect(deleteBtn.className).toMatch(/shrink-0/);
    await user.click(deleteBtn);

    expect(await screen.findByRole("heading", { name: "Delete album?" })).toBeInTheDocument();
    expect(
      screen.getByText(/Its photos stay in your library\. Everyone it is shared with loses access/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Delete album$/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/photos/albums/a/alb1") &&
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
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/albums")) {
        return new Response(JSON.stringify([album]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos?")) {
        return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/photos#albums");
    const user = userEvent.setup();
    renderPhotos();

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

  it.each([
    { role: "admin", myCaps: "full+share", canMakeLink: true },
    { role: "user", myCaps: "view+share", canMakeLink: true },
    { role: "user", myCaps: "view", canMakeLink: false },
  ])("opens album sharing from the card with $myCaps", async ({ role, myCaps, canMakeLink }) => {
    const album = {
      id: "alb-share",
      home_drive_id: "a",
      name: "Shared Moments",
      item_count: 5,
      cover_thumb: "/thumb",
    };
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/auth/me") || u.endsWith("/auth/status")) {
        return Response.json({ id: "u1", username: "sam", role, has_admin: true });
      }
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Drive A" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/api/v1/access/subject")) {
        return new Response(
          JSON.stringify({
            subject: {
              kind: "album",
              drive_id: "a",
              path: "",
              album_id: "alb-share",
              is_file: false,
              exists: true,
              name: "Shared Moments",
              item_count: 5,
            },
            my_caps: myCaps,
            members: [],
            links: [
              {
                id: "lnk-1",
                caps: "view+upload",
                has_password: false,
                expires_at: null,
                created_at: 1,
                created_by: "u1",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/users/directory")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/albums")) {
        return new Response(JSON.stringify([album]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos?")) {
        return new Response(JSON.stringify({ items: [], next_offset: 0, has_more: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/photos#albums");
    const user = userEvent.setup();
    renderPhotos();

    expect(await screen.findByText("Shared Moments")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Share album Shared Moments" }));

    expect(await screen.findByRole("heading", { name: "Sharing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Links" })).toBeInTheDocument();
    if (canMakeLink) {
      expect(screen.getByRole("button", { name: /New link/i })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole("button", { name: /New link|Copy link/i })).not.toBeInTheDocument();
    }
    if (role === "user") {
      expect(screen.queryByRole("button", { name: /Rename album|Delete album/i })).not.toBeInTheDocument();
    }
    expect(await screen.findByText(/Can view \+ add photos/)).toBeInTheDocument();
  });

  it("labels the album card's button Share but keeps the album in its accessible name", async () => {
    stubPhotosFetch({
      albums: [{ id: "alb-label", home_drive_id: "a", name: "Summer", item_count: 3 }],
    });
    window.history.replaceState(null, "", "/photos#albums");
    renderPhotos();

    expect(await screen.findByText("Summer")).toBeInTheDocument();
    const share = screen.getByRole("button", { name: "Share album Summer" });
    // The visible label lost "album"; the accessible name keeps it so the
    // card's other buttons stay distinguishable.
    expect(share).toHaveTextContent(/^Share$/);
  });

  it("shows a dismissable On this day pill that opens a filter view", async () => {
    localStorage.clear();
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/auth/me") || u.endsWith("/auth/status")) {
        return new Response(
          JSON.stringify({ id: "1", username: "max", role: "admin", has_admin: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/setup")) {
        return new Response(
          JSON.stringify({ name: "Luna", setup_completed: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "a", label: "Family" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos/status")) {
        return new Response(JSON.stringify(STATUS_OK), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/photos?")) {
        const items = u.includes("month_day=")
          ? [
              {
                drive_id: "a",
                path: "memory.jpg",
                name: "memory.jpg",
                taken_at: 1_647_216_000,
                thumb: "/tm",
                kind: "image",
              },
            ]
          : [
              {
                drive_id: "a",
                path: "one.jpg",
                name: "one.jpg",
                taken_at: 1_700_000_000,
                thumb: "/t1",
                kind: "image",
              },
            ];
        return new Response(
          JSON.stringify({ items, next_offset: items.length, has_more: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPhotos();

    // The pill appears once the probe finds photos from previous years.
    const openBtn = await screen.findByRole("button", { name: /On this day · 1 photo/i });
    expect(screen.getByRole("button", { name: /Dismiss On this day/i })).toBeInTheDocument();

    // It opens a filter view: chrome label, deep link, only memory photos.
    fireEvent.click(openBtn);
    expect(await screen.findByLabelText("memory.jpg")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("one.jpg")).not.toBeInTheDocument());
    const chrome = document.querySelector("[data-slot=photos-detail-chrome]");
    expect(chrome).toBeTruthy();
    expect(
      within(/** @type {HTMLElement} */ (chrome)).getByText("On this day"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.hash).toBe("#onthisday");
    });

    // A filter view offers Save as album, prefilled with the view name.
    fireEvent.click(
      within(/** @type {HTMLElement} */ (chrome)).getByRole("button", {
        name: /Save as album/i,
      }),
    );
    expect(await screen.findByLabelText(/Album name/i)).toHaveValue("On this day");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    // It rides the same rail as other filters: the chip can dismiss the view.
    fireEvent.click(
      await screen.findByRole("button", { name: /Remove filter On this day/i }),
    );
    expect(await screen.findByLabelText("one.jpg")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("memory.jpg")).not.toBeInTheDocument());

    // Reopen, then Back also returns to the library and the pill comes back.
    fireEvent.click(
      await screen.findByRole("button", { name: /On this day · 1 photo/i }),
    );
    expect(await screen.findByLabelText("memory.jpg")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /^Back$/i }));
    expect(
      await screen.findByRole("button", { name: /On this day · 1 photo/i }),
    ).toBeInTheDocument();

    // Dismiss hides it for the rest of the day.
    fireEvent.click(screen.getByRole("button", { name: /Dismiss On this day/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /On this day ·/i }),
      ).not.toBeInTheDocument();
    });
  });
});

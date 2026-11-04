import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import { FileOpsProvider } from "../../context/FileOpsContext.jsx";
import FileSearch, { FileSearchButton } from "./FileSearch";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider, useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";

const IDLE_SCAN = { scanning: false, drives_total: 1, drives_done: 1, dirs_indexed: 0 };

/**
 * @param {unknown[]} hits
 * @param {{
 *   searchHold?: Promise<void>,
 *   initialPath?: string,
 *   role?: string,
 *   connectActive?: boolean,
 *   extra?: import("react").ReactNode,
 *   before?: import("react").ReactNode,
 *   scan?: Record<string, unknown> | (() => Record<string, unknown>),
 *   closeOnly?: boolean,
 *   truncated?: boolean,
 *   incomplete?: boolean,
 *   searchError?: boolean,
 *   holdSecond?: Promise<void>,
 *   fileOpsStore?: any,
 * }} [options]
 */
function renderSearch(hits, { initialPath = "/", role = "admin", connectActive = false, searchHold, extra = null, before = null, scan = IDLE_SCAN, closeOnly = false, truncated = false, incomplete = false, searchError = false, holdSecond, fileOpsStore } = {}) {
  let searchCount = 0;
  const fetchMock = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me") || u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role, username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/auth/status")) {
      return new Response(JSON.stringify({ has_admin: true, connect_active: connectActive }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/drives")) {
      return new Response(JSON.stringify([{ id: "d1", label: "Photos Drive" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/search")) {
      if (searchHold) await searchHold;
      if (holdSecond && searchCount++ >= 1) await holdSecond;
      if (searchError) {
        return new Response(JSON.stringify({ error: "Luna's index is busy. Try again." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          hits,
          close_only: closeOnly,
          truncated,
          incomplete,
          scan: typeof scan === "function" ? scan() : scan,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.endsWith("/shares") || u.endsWith("/grants") || u.endsWith("/users") || u.endsWith("/protections")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <ToastProvider>
    <ShortcutsProvider>
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <FileOpsProvider store={fileOpsStore}>
          {before}
          <FileSearchButton />
          <FileSearch />
          {extra}
          </FileOpsProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
    </ShortcutsProvider>
    </ToastProvider>
  );
  return { ...view, fetchMock };
}

/** @param {import("vitest").Mock} fetchMock */
function searchCalls(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((u) => u.includes("/api/v1/search"));
}

async function openSearchOverlay() {
  const trigger = await screen.findByRole("button", { name: "Search" });
  fireEvent.click(trigger);
  return screen.findByRole("dialog", { name: "Search Luna" });
}

describe("FileSearch", () => {
  it("opens a morphing overlay from the header search button", async () => {
    renderSearch([]);
    expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument();
    const dialog = await openSearchOverlay();
    expect(dialog).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: "Search Luna" });
    expect(box).toHaveAttribute("placeholder", "Search Luna");
    // No cycling example text on top of it.
    expect(document.querySelector("[data-slot=file-search-example]")).toBeNull();
    expect(screen.getByRole("button", { name: "Close search" })).toBeInTheDocument();
  });

  it("keeps the best file ahead of matching places for keyboard selection", async () => {
    renderSearch([{ drive_id: "d1", path: "home", parent: "", name: "home", kind: "dir", size: 0, modified: 0, match: "name" }]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "home" } });
    await screen.findByRole("link", { name: /open home/i });
    const links = document.querySelectorAll('[data-slot="file-search-link"]');
    expect(links[0]).toHaveAccessibleName(/open home/i);
    expect(Array.from(links).some((link) => link.textContent === "Home")).toBe(true);
  });

  it("moves focus to the first newly revealed file", async () => {
    const hits = Array.from({ length: 7 }, (_, index) => ({
      drive_id: "d1", path: `report${index}.txt`, parent: "", name: `report${index}.txt`,
      kind: "file", size: 0, modified: 0, match: "name",
    }));
    renderSearch(hits);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "report" } });
    const more = await screen.findByRole("button", { name: "Show more files" });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByRole("link", { name: /^Open report5\.txt$/i })).toHaveFocus());
  });

  it.each([
    { role: "admin", connectActive: true, visible: true },
    { role: "admin", connectActive: false, visible: false },
    { role: "member", connectActive: true, visible: false },
  ])("limits Luna Connect settings to eligible users: $role, active=$connectActive", async ({ role, connectActive, visible }) => {
    renderSearch([], { role, connectActive });
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    fireEvent.change(input, { target: { value: "appearance" } });
    await screen.findByRole("link", { name: /^Appearance$/i });
    fireEvent.change(input, { target: { value: "Luna Connect" } });
    if (visible) {
      expect(await screen.findByRole("link", { name: /^Luna Connect$/i })).toBeInTheDocument();
    } else {
      await waitFor(() => expect(screen.queryByRole("link", { name: /^Luna Connect$/i })).not.toBeInTheDocument());
    }
  });

  it.each([{ role: "admin", visible: true }, { role: "member", visible: false }])(
    "limits Users settings to Admins: $role", async ({ role, visible }) => {
      renderSearch([], { role });
      await openSearchOverlay();
      const input = screen.getByRole("textbox", { name: "Search Luna" });
      fireEvent.change(input, { target: { value: "appearance" } });
      await screen.findByRole("link", { name: /^Appearance$/i });
      fireEvent.change(input, { target: { value: "users" } });
      if (visible) {
        expect(await screen.findByRole("link", { name: /^Users$/i })).toBeInTheDocument();
      } else {
        await waitFor(() => expect(screen.queryByRole("link", { name: /^Users$/i })).not.toBeInTheDocument());
      }
    },
  );

  it("moves focus to a newly revealed setting", async () => {
    renderSearch([]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "security" } });
    const more = await screen.findByRole("button", { name: "Show more settings" });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByRole("link", { name: /sign out all apps/i })).toHaveFocus());
  });

  it("opens the visible exact place when file results are still loading", async () => {
    let release = () => {};
    const searchHold = new Promise((resolve) => { release = () => resolve(undefined); });
    function Location() {
      const { pathname } = useLocation();
      return <output aria-label="Current page">{pathname}</output>;
    }
    const { fetchMock } = renderSearch([], { searchHold, initialPath: "/files", extra: <Location /> });
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    fireEvent.change(input, { target: { value: "home" } });
    expect(await screen.findByRole("link", { name: "Home" })).toBeInTheDocument();
    await waitFor(() => expect(searchCalls(fetchMock)).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByLabelText("Current page")).toHaveTextContent(/^\/$/));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument());
    release();
  });

  it("groups ranked matches by type", async () => {
    /** @param {string} name @param {string} kind */
    const hit = (name, kind) => ({ drive_id: "d1", path: name, parent: "", name, kind, size: 0, modified: 0, match: "name" });
    renderSearch([hit("budget.jpg", "file"), hit("budget.txt", "file"), hit("budget", "dir")]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "budget" } });
    await screen.findByRole("link", { name: "Open budget.txt" });
    const list = /** @type {HTMLElement} */ (document.querySelector('[data-slot="file-search-list"]'));
    const labels = Array.from(list.children).map((child) => child.getAttribute("role") === "presentation" ? child.textContent : child.querySelector('[data-slot="file-search-link"]')?.getAttribute("aria-label"));
    expect(labels).toEqual(["Best match", "Open budget.jpg", "Folders", "Open budget", "Files", "Open budget.txt"]);
  });

  it("keeps the highest-ranked file as the default before a weaker folder", async () => {
    renderSearch([
      { drive_id: "d1", path: "report.txt", parent: "", name: "report.txt", kind: "file", size: 0, modified: 0, match: "name" },
      { drive_id: "d1", path: "reports", parent: "", name: "reports", kind: "dir", size: 0, modified: 0, match: "close" },
    ]);
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    fireEvent.change(input, { target: { value: "report" } });
    const best = await screen.findByRole("link", { name: "Open report.txt" });
    const list = /** @type {HTMLElement} */ (document.querySelector('[data-slot="file-search-list"]'));
    expect(list.querySelector('[data-slot="file-search-link"]')).toBe(best);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument());
  });

  it("closes on Escape and restores focus to the header button", async () => {
    renderSearch([]);
    const trigger = await screen.findByRole("button", { name: "Search" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Search Luna" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("shows placeholder rows while the first results load", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releaseSearch;
    const searchHold = new Promise((resolve) => {
      releaseSearch = resolve;
    });
    renderSearch([], { searchHold });
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "zzqzxnomatch" },
    });
    expect(await screen.findByRole("status", { name: /Searching/i })).toBeInTheDocument();
    releaseSearch?.();
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.queryByText(/Searching/i)).not.toBeInTheDocument();
  });

  it("does not claim there are no matches when the search budget was exhausted", async () => {
    renderSearch([], { incomplete: true });
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "budget" } });
    expect(await screen.findByText(/could not check every match/i)).toBeInTheDocument();
    expect(screen.queryByText("Nothing matched")).not.toBeInTheDocument();
  });

  it("hides stale incomplete and duplicate truncated notices while a new search loads", async () => {
    /** @type {() => void} */
    let releaseSecond = () => {};
    const holdSecond = new Promise((resolve) => { releaseSecond = () => resolve(undefined); });
    renderSearch([{ drive_id: "d1", path: "budget.txt", parent: "", name: "budget.txt", kind: "file", size: 1, modified: 1 }], { incomplete: true, truncated: true, holdSecond });
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    fireEvent.change(input, { target: { value: "budget" } });
    expect(await screen.findByText(/could not check every match/i)).toBeInTheDocument();
    expect(document.querySelector("[data-slot=file-search-truncated]")).toBeNull();
    fireEvent.change(input, { target: { value: "budgets" } });
    expect(screen.queryByText(/could not check every match/i)).not.toBeInTheDocument();
    await act(async () => { releaseSecond(); });
    expect(await screen.findByText(/could not check every match/i)).toBeInTheDocument();
  });

  it("explains an empty search in plain language", async () => {
    renderSearch([]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "zzqzxnomatch" },
    });
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.getByText(/Try another name or browse Luna/i)).toBeInTheDocument();
  });

  it("offers open and download actions on a file hit", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album/beach.jpg",
        parent: "album",
        name: "beach.jpg",
        kind: "file",
        size: 2048,
        modified: 1,
      },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "beach" },
    });
    expect(await screen.findByRole("link", { name: /^Open beach.jpg$/i })).toBeInTheDocument();
    expect(screen.getByText(/Photos Drive \/ album/i)).toBeInTheDocument();

    const row = await screen.findByRole("link", { name: /^Open beach.jpg$/i });
    expect(row).toHaveAttribute("href", "/files/d1?path=album&file=beach.jpg");

    const open = screen.getByRole("link", { name: /Go to folder for beach.jpg/i });
    expect(open).toHaveAttribute("href", "/files/d1?path=album&select=album%2Fbeach.jpg");

    const download = screen.getByRole("link", { name: /Download beach.jpg/i });
    expect(download).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=album%2Fbeach.jpg&download=1"
    );

    expect(screen.getByRole("button", { name: /Sharing for beach.jpg/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy beach.jpg/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move beach.jpg$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move beach.jpg to trash/i })).toBeInTheDocument();
  });

  it("shows one lightning-bolt button on phones that opens the actions", async () => {
    const original = window.matchMedia;
    window.matchMedia = (query) => /** @type {any} */ ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    try {
      renderSearch([
        {
          drive_id: "d1",
          path: "album/beach.jpg",
          parent: "album",
          name: "beach.jpg",
          kind: "file",
          size: 2048,
          modified: 1,
        },
      ]);
      await openSearchOverlay();
      fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
        target: { value: "beach" },
      });
      const bolt = await screen.findByRole("button", { name: "Actions for beach.jpg" });
      expect(screen.queryByRole("button", { name: /Copy beach.jpg/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /Download beach.jpg/i })).not.toBeInTheDocument();
      fireEvent.click(bolt);
      expect(await screen.findByRole("button", { name: "Copy" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to folder" })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it("keeps select= for a file the viewer can't open", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album/data.bin",
        parent: "album",
        name: "data.bin",
        kind: "file",
        size: 10,
        modified: 1,
      },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "data" },
    });
    const row = await screen.findByRole("link", { name: /Show data.bin in its folder/i });
    expect(row).toHaveAttribute("href", "/files/d1?path=album&select=album%2Fdata.bin");
  });

  it("opens a folder hit into that folder", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album",
        parent: "",
        name: "album",
        kind: "dir",
        size: 0,
        modified: 1,
      },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "alb" },
    });
    const opens = await screen.findAllByRole("link", { name: /^Open album$/i });
    expect(opens.length).toBeGreaterThanOrEqual(1);
    for (const open of opens) {
      expect(open).toHaveAttribute("href", "/files/d1?path=album");
    }
    const download = screen.getByRole("link", { name: /Download album/i });
    expect(download).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=album&download=1",
    );
  });

  it("closes the overlay when a result row is activated", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album/beach.jpg",
        parent: "album",
        name: "beach.jpg",
        kind: "file",
        size: 2048,
        modified: 1,
      },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "beach" },
    });
    const row = await screen.findByRole("link", { name: /^Open beach.jpg$/i });
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument(),
    );
  });

  it("keeps action buttons from also triggering row navigation", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "notes.txt",
        parent: "",
        name: "notes.txt",
        kind: "file",
        size: 10,
        modified: 1,
      },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "notes" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Copy notes.txt/i }));
    expect(await screen.findByRole("dialog", { name: /Copy notes.txt/i })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Search Luna" })).toBeInTheDocument();
  });
  it("shows tooltips on search result action buttons", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSearch([
      {
        drive_id: "d1",
        path: "notes.txt",
        parent: "",
        name: "notes.txt",
        kind: "file",
        size: 10,
        modified: 1,
      },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    expect(await screen.findByRole("dialog", { name: "Search Luna" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "notes" },
    });
    expect(await screen.findByRole("button", { name: /Copy notes.txt/i })).toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: /Copy notes.txt/i }));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");

    await user.hover(screen.getByRole("button", { name: /Move notes.txt to trash/i }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move to trash");

    vi.useRealTimers();
  });

  it("confirms trash from a search hit", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "notes.txt",
        parent: "",
        name: "notes.txt",
        kind: "file",
        size: 10,
        modified: 1,
      },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "notes" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Move notes.txt to trash/i }));
    const dialog = await screen.findByRole("dialog", { name: /Move to trash/i });
    expect(within(dialog).getByText(/Move to trash\?/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Move to trash/i })).toBeInTheDocument();
  });

  it("hands a copy from a search hit to the file operation card", async () => {
    const startJobs = vi.fn();
    renderSearch(
      [{ drive_id: "d1", path: "docs/notes.txt", parent: "docs", name: "notes.txt", kind: "file", size: 10, modified: 1 }],
      { fileOpsStore: { startJobs, subscribe: () => () => {}, getState: () => ({}) } },
    );
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), {
      target: { value: "notes" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Copy notes.txt/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Start copying/i }));
    await waitFor(() => expect(startJobs).toHaveBeenCalledTimes(1));
    expect(startJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "copy",
        fromDrive: "d1",
        items: [{ path: "docs/notes.txt", name: "notes.txt" }],
      }),
    );
  });

  it("opens from / and Alt+/ anywhere", async () => {
    renderSearch([]);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(await screen.findByRole("dialog", { name: "Search Luna" })).toBeInTheDocument();
  });

  it("opens from Alt+/ while typing in another field", async () => {
    renderSearch([], { extra: <input aria-label="Some field" /> });
    fireEvent.keyDown(screen.getByLabelText("Some field"), { key: "/", code: "Slash", altKey: true });
    expect(await screen.findByRole("dialog", { name: "Search Luna" })).toBeInTheDocument();
  });

  it("leaves / to a page's own search but keeps Alt+/", async () => {
    const own = vi.fn();
    function PageSearch() {
      useShortcut("/", own, { label: "Search here", priority: 1 });
      return null;
    }
    renderSearch([], { extra: <PageSearch /> });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(own).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "/", code: "Slash", altKey: true });
    expect(await screen.findByRole("dialog", { name: "Search Luna" })).toBeInTheDocument();
  });

  it("uses the visible header button, not HeaderCard's hidden copy that comes first", async () => {
    renderSearch([], { before: <div aria-hidden="true"><FileSearchButton /></div> });
    const [hidden, real] = screen.getAllByRole("button", { name: "Search", hidden: true });
    fireEvent.keyDown(document.body, { key: "/" });
    await screen.findByRole("dialog", { name: "Search Luna" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument());
    expect(real).toHaveFocus();
    expect(hidden).not.toHaveFocus();
  });

  it("navigates down from the searchbar to results and back up with arrow keys", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album/beach.jpg",
        parent: "album",
        name: "beach.jpg",
        kind: "file",
        size: 2048,
        modified: 1,
      },
      {
        drive_id: "d1",
        path: "album/sunset.jpg",
        parent: "album",
        name: "sunset.jpg",
        kind: "file",
        size: 4096,
        modified: 2,
      },
    ]);
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    fireEvent.change(input, { target: { value: "jpg" } });

    const firstRow = await screen.findByRole("link", { name: /^Open beach.jpg$/i });
    const secondRow = await screen.findByRole("link", { name: /^Open sunset.jpg$/i });

    // Focus starts in the searchbar
    input.focus();
    expect(input).toHaveFocus();

    // Down arrow from the searchbar moves focus to the first result
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(firstRow).toHaveFocus();

    // Down arrow from the first result moves to the second result
    fireEvent.keyDown(firstRow, { key: "ArrowDown" });
    expect(secondRow).toHaveFocus();

    // Up arrow from the second result moves back to the first result
    fireEvent.keyDown(secondRow, { key: "ArrowUp" });
    expect(firstRow).toHaveFocus();

    // Up arrow from the first result moves back up to the searchbar
    fireEvent.keyDown(firstRow, { key: "ArrowUp" });
    expect(input).toHaveFocus();
  });

  it("navigates up to the searchbar from an action button on the first result", async () => {
    renderSearch([
      {
        drive_id: "d1",
        path: "album/beach.jpg",
        parent: "album",
        name: "beach.jpg",
        kind: "file",
        size: 2048,
        modified: 1,
      },
    ]);
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    fireEvent.change(input, { target: { value: "beach" } });

    const copyBtn = await screen.findByRole("button", { name: /Copy beach.jpg/i });
    act(() => {
      copyBtn.focus();
    });
    expect(copyBtn).toHaveFocus();

    // Up arrow from an action button on the first row goes up to the searchbar
    act(() => {
      fireEvent.keyDown(copyBtn, { key: "ArrowUp" });
    });
    expect(input).toHaveFocus();
  });

  it("does not error when pressing ArrowDown with no results", async () => {
    renderSearch([]);
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    input.focus();
    expect(input).toHaveFocus();

    // Down arrow when empty does not crash and leaves focus on input
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveFocus();
  });
  it("underlines the part of a name that matches", async () => {
    renderSearch([
      { drive_id: "d1", path: "beach day.jpg", parent: "", name: "beach day.jpg", kind: "file", size: 1, modified: 1, match: "name" },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "beach" } });
    const link = await screen.findByRole("link", { name: /^Open beach day.jpg$/i });
    const underlined = link.closest("[data-slot=file-search-item]")?.querySelector(".underline");
    expect(underlined).toHaveTextContent("beach");
  });

  it("asks for only folders or only files when you pick one", async () => {
    const { fetchMock } = renderSearch([]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "photos" } });
    await waitFor(() => expect(searchCalls(fetchMock)).toContain("/api/v1/search?q=photos"));
    fireEvent.click(screen.getByRole("radio", { name: "Folders" }));
    await waitFor(() => expect(searchCalls(fetchMock)).toContain("/api/v1/search?q=photos&kind=dir"));
    fireEvent.click(screen.getByRole("radio", { name: "Files" }));
    await waitFor(() => expect(searchCalls(fetchMock)).toContain("/api/v1/search?q=photos&kind=file"));
  });

  it("says when every result is only a close match", async () => {
    renderSearch(
      [{ drive_id: "d1", path: "passport.pdf", parent: "", name: "passport.pdf", kind: "file", size: 1, modified: 1, match: "close" }],
      { closeOnly: true },
    );
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "pasport" } });
    expect(await screen.findByText(/Nothing matched exactly\. These names are close\./)).toBeInTheDocument();
    expect(screen.queryByText("Similar names")).not.toBeInTheDocument();
  });

  it("separates near misses from real matches in a mixed list", async () => {
    renderSearch([
      { drive_id: "d1", path: "my pasport.pdf", parent: "", name: "my pasport.pdf", kind: "file", size: 1, modified: 1, match: "name" },
      { drive_id: "d1", path: "passport.pdf", parent: "", name: "passport.pdf", kind: "file", size: 1, modified: 1, match: "close" },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "pasport" } });
    expect(await screen.findByText("Similar names")).toBeInTheDocument();
    const items = screen.getAllByRole("link", { name: /^Open / });
    expect(items.map((el) => el.getAttribute("aria-label"))).toEqual([
      "Open my pasport.pdf",
      "Open passport.pdf",
    ]);
  });

  it("keeps searching while Luna is still reading drives, and says so", async () => {
    let calls = 0;
    const { fetchMock } = renderSearch(
      [{ drive_id: "d1", path: "a/found.txt", parent: "a", name: "found.txt", kind: "file", size: 1, modified: 1, match: "name" }],
      {
        scan: () => {
          calls += 1;
          return calls < 3
            ? { scanning: true, drives_total: 2, drives_done: 1, dirs_indexed: 1200 }
            : IDLE_SCAN;
        },
      },
    );
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "found" } });
    expect(await screen.findByRole("link", { name: /^Open found.txt$/i })).toBeInTheDocument();
    // Results are already on screen; the page asks again on its own.
    await waitFor(() => expect(searchCalls(fetchMock).length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
    // The notice waits a moment so quick scans stay silent, then appears.
    await waitFor(
      () => expect(document.querySelector("[data-slot=file-search-status]")).toHaveTextContent(/reading your drives/i),
      { timeout: 5000 },
    );
    // Once the scan is over it stops asking.
    const settled = searchCalls(fetchMock).length;
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "clearTimeout"] });
    try {
      // Well past a couple of 1.2s polls.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(searchCalls(fetchMock).length).toBe(settled);
  }, 15000);

  it("explains an empty search while drives are still being read", async () => {
    renderSearch([], { scan: { scanning: true, drives_total: 1, drives_done: 0, dirs_indexed: 5 } });
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "zzqzxnomatch" } });
    expect(await screen.findByText("Nothing yet")).toBeInTheDocument();
    expect(screen.getByText(/still reading your drives/i)).toBeInTheDocument();
  });

  it("opens the best match when Enter is pressed in the search box", async () => {
    renderSearch([
      { drive_id: "d1", path: "a/beach.jpg", parent: "a", name: "beach.jpg", kind: "file", size: 1, modified: 1 },
    ]);
    await openSearchOverlay();
    const input = screen.getByRole("textbox", { name: "Search Luna" });
    fireEvent.change(input, { target: { value: "beach" } });
    await screen.findByRole("link", { name: /^Open beach.jpg$/i });
    fireEvent.keyDown(input, { key: "Enter" });
    // Following the link closes the overlay.
    await waitFor(
      () => expect(screen.queryByRole("dialog", { name: "Search Luna" })).not.toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("keeps a row to one Tab stop and reaches its actions with the arrow keys", async () => {
    renderSearch([
      { drive_id: "d1", path: "a/beach.jpg", parent: "a", name: "beach.jpg", kind: "file", size: 1, modified: 1 },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "beach" } });
    const row = await screen.findByRole("link", { name: /^Open beach.jpg$/i });
    const actions = document.querySelector("[data-slot=file-search-actions]");
    for (const el of actions.querySelectorAll("a, button")) {
      expect(el).toHaveAttribute("tabindex", "-1");
    }
    row.focus();
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(screen.getByRole("link", { name: /Go to folder for beach.jpg/i })).toHaveFocus();
    fireEvent.keyDown(document.activeElement, { key: "ArrowLeft" });
    expect(row).toHaveFocus();
  });

  it("jumps to the first and last result with Home and End", async () => {
    renderSearch([
      { drive_id: "d1", path: "one.txt", parent: "", name: "one.txt", kind: "file", size: 1, modified: 1 },
      { drive_id: "d1", path: "two.txt", parent: "", name: "two.txt", kind: "file", size: 1, modified: 1 },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "txt" } });
    const first = await screen.findByRole("link", { name: /^Open one.txt$/i });
    const last = screen.getByRole("link", { name: /^Open two.txt$/i });
    first.focus();
    fireEvent.keyDown(first, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
  });

  it("offers no second 'open' button on a folder, and shows where and when", async () => {
    renderSearch([
      { drive_id: "d1", path: "a/b/c/Spain", parent: "a/b/c", name: "Spain", kind: "dir", size: 0, modified: 1 },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "spain" } });
    await screen.findByRole("link", { name: /^Open Spain$/i });
    expect(screen.queryByRole("link", { name: /Go to folder for Spain/i })).not.toBeInTheDocument();
    // The middle of a long path collapses so the last folders stay visible.
    expect(screen.getByText("Photos Drive / … / b / c")).toBeInTheDocument();
    expect(screen.getAllByText(/^· /).length).toBeGreaterThan(0);
  });

  it("says when more matches exist than fit", async () => {
    renderSearch(
      [{ drive_id: "d1", path: "one.txt", parent: "", name: "one.txt", kind: "file", size: 1, modified: 1 }],
      { truncated: true },
    );
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "one" } });
    await screen.findByRole("link", { name: /^Open one.txt$/i });
    expect(document.querySelector("[data-slot=file-search-truncated]")).toHaveTextContent(/more matches/i);
  });

  it("warns when a drive could not be read", async () => {
    renderSearch([], { scan: { scanning: false, drives_total: 2, drives_done: 1, drives_failed: 1, dirs_indexed: 0 } });
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "zzqzxnomatch" } });
    await waitFor(() =>
      expect(document.querySelector("[data-slot=file-search-status]")).toHaveTextContent(
        "Luna couldn't read 1 drive, so some files may not show up.",
      ),
    );
  });

  it("offers a retry when searching fails", async () => {
    const { fetchMock } = renderSearch([], { searchError: true });
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "zzqzxnomatch" } });
    const retry = await screen.findByRole("button", { name: "Try again" });
    const before = searchCalls(fetchMock).length;
    fireEvent.click(retry);
    await waitFor(() => expect(searchCalls(fetchMock).length).toBeGreaterThan(before));
  });

  it("remembers the Files / Folders choice", async () => {
    window.localStorage.removeItem("luna.fileSearch.kind");
    renderSearch([]);
    await openSearchOverlay();
    // The choice is there before anything is typed, so nothing shifts later.
    fireEvent.click(screen.getByRole("radio", { name: "Folders" }));
    expect(window.localStorage.getItem("luna.fileSearch.kind")).toBe("dir");
    window.localStorage.removeItem("luna.fileSearch.kind");
  });

  it("shows the loading bar when a newer answer is slow, and eases it out after", async () => {
    /** @type {(() => void) | undefined} */
    let release;
    const holdSecond = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    renderSearch(
      [{ drive_id: "d1", path: "one.txt", parent: "", name: "one.txt", kind: "file", size: 1, modified: 1 }],
      { holdSecond },
    );
    await openSearchOverlay();
    fireEvent.change(screen.getByRole("textbox", { name: "Search Luna" }), { target: { value: "one" } });
    await screen.findByRole("link", { name: /^Open one.txt$/i });
    expect(screen.queryByRole("progressbar", { name: "Updating results" })).not.toBeInTheDocument();

    // A new search while the old list stays up: the bar waits out its delay.
    fireEvent.click(screen.getByRole("radio", { name: "Files" }));
    expect(screen.queryByRole("progressbar", { name: "Updating results" })).not.toBeInTheDocument();
    const bar = await screen.findByRole("progressbar", { name: "Updating results" }, { timeout: 2000 });
    expect(bar).toHaveAttribute("data-phase", "in");

    release?.();
    await waitFor(() => expect(bar).toHaveAttribute("data-phase", "out"), { timeout: 2000 });
    await waitFor(
      () => expect(screen.queryByRole("progressbar", { name: "Updating results", hidden: true })).not.toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("shows a lock on a private hit", async () => {
    renderSearch([
      { drive_id: "d1", path: "Taxes", parent: "", name: "Taxes", kind: "dir", size: 0, modified: 1, private: true },
      { drive_id: "d1", path: "Tax notes.txt", parent: "", name: "Tax notes.txt", kind: "file", size: 10, modified: 1, private: false },
    ]);
    await openSearchOverlay();
    fireEvent.change(screen.getByPlaceholderText("Search Luna"), { target: { value: "tax" } });
    expect(await screen.findByLabelText("Open Tax notes.txt")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Private")).toHaveLength(1);
  });
});


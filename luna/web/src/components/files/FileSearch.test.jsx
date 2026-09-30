import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import FileSearch, { FileSearchButton } from "./FileSearch";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider, useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";

/** @param {unknown[]} hits @param {{ searchHold?: Promise<void>, extra?: import("react").ReactNode, before?: import("react").ReactNode }} [options] */
function renderSearch(hits, { searchHold, extra = null, before = null } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/auth/me") || u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
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
      return new Response(JSON.stringify(hits), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/shares") || u.endsWith("/grants") || u.endsWith("/users") || u.endsWith("/protections")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
    <ShortcutsProvider>
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          {before}
          <FileSearchButton />
          <FileSearch />
          {extra}
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
    </ShortcutsProvider>
    </ToastProvider>
  );
}

async function openSearchOverlay() {
  const trigger = await screen.findByRole("button", { name: "Search" });
  fireEvent.click(trigger);
  return screen.findByRole("dialog", { name: "Search for a file" });
}

describe("FileSearch", () => {
  it("opens a morphing overlay from the header search button", async () => {
    renderSearch([]);
    expect(screen.queryByRole("dialog", { name: "Search for a file" })).not.toBeInTheDocument();
    const dialog = await openSearchOverlay();
    expect(dialog).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search for a file")).toHaveAttribute(
      "aria-label",
      "Search for a file",
    );
    expect(screen.getByRole("button", { name: "Close search" })).toBeInTheDocument();
  });

  it("closes on Escape and restores focus to the header button", async () => {
    renderSearch([]);
    const trigger = await screen.findByRole("button", { name: "Search" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Search for a file" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(screen.queryByRole("dialog", { name: "Search for a file" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows Searching over the dot matrix while results load", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releaseSearch;
    const searchHold = new Promise((resolve) => {
      releaseSearch = resolve;
    });
    renderSearch([], { searchHold });
    await openSearchOverlay();
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "zz" },
    });
    const loader = await screen.findByRole("status", { name: /Searching/i });
    expect(loader.querySelector("[data-slot=matrix-canvas]")).toBeTruthy();
    releaseSearch?.();
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.queryByText(/Searching/i)).not.toBeInTheDocument();
  });

  it("explains an empty search in plain language", async () => {
    renderSearch([]);
    await openSearchOverlay();
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "zz" },
    });
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.getByText(/only shows files you're allowed to see/i)).toBeInTheDocument();
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
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "beach" },
    });
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByText(/Photos Drive \/ album/i)).toBeInTheDocument();

    const row = await screen.findByRole("link", { name: /^Open beach.jpg$/i });
    expect(row).toHaveAttribute("href", "/drives/d1?path=album&file=beach.jpg");

    const open = screen.getByRole("link", { name: /Go to folder for beach.jpg/i });
    expect(open).toHaveAttribute("href", "/drives/d1?path=album&select=album%2Fbeach.jpg");

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
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "data" },
    });
    const row = await screen.findByRole("link", { name: /Show data.bin in its folder/i });
    expect(row).toHaveAttribute("href", "/drives/d1?path=album&select=album%2Fdata.bin");
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
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "alb" },
    });
    const opens = await screen.findAllByRole("link", { name: /^Open album$/i });
    expect(opens.length).toBeGreaterThanOrEqual(1);
    for (const open of opens) {
      expect(open).toHaveAttribute("href", "/drives/d1?path=album");
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
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "beach" },
    });
    const row = await screen.findByRole("link", { name: /^Open beach.jpg$/i });
    fireEvent.click(row);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(screen.queryByRole("dialog", { name: "Search for a file" })).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "notes" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Copy notes.txt/i }));
    expect(await screen.findByRole("dialog", { name: /Copy notes.txt/i })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Search for a file" })).toBeInTheDocument();
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
    expect(await screen.findByRole("dialog", { name: "Search for a file" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "notes" },
    });
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

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
    fireEvent.change(screen.getByPlaceholderText("Search for a file"), {
      target: { value: "notes" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Move notes.txt to trash/i }));
    const dialog = await screen.findByRole("dialog", { name: /Move to trash/i });
    expect(within(dialog).getByText(/Move to trash\?/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Move to trash/i })).toBeInTheDocument();
  });

  it("opens from / and Alt+/ anywhere", async () => {
    renderSearch([]);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(await screen.findByRole("dialog", { name: "Search for a file" })).toBeInTheDocument();
  });

  it("opens from Alt+/ while typing in another field", async () => {
    renderSearch([], { extra: <input aria-label="Some field" /> });
    fireEvent.keyDown(screen.getByLabelText("Some field"), { key: "/", code: "Slash", altKey: true });
    expect(await screen.findByRole("dialog", { name: "Search for a file" })).toBeInTheDocument();
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
    expect(screen.queryByRole("dialog", { name: "Search for a file" })).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "/", code: "Slash", altKey: true });
    expect(await screen.findByRole("dialog", { name: "Search for a file" })).toBeInTheDocument();
  });

  it("uses the visible header button, not HeaderCard's hidden copy that comes first", async () => {
    renderSearch([], { before: <div aria-hidden="true"><FileSearchButton /></div> });
    const [hidden, real] = screen.getAllByRole("button", { name: "Search", hidden: true });
    fireEvent.keyDown(document.body, { key: "/" });
    await screen.findByRole("dialog", { name: "Search for a file" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search for a file" })).not.toBeInTheDocument());
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
    const input = screen.getByPlaceholderText("Search for a file");
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
    const input = screen.getByPlaceholderText("Search for a file");
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
    const input = screen.getByPlaceholderText("Search for a file");
    input.focus();
    expect(input).toHaveFocus();

    // Down arrow when empty does not crash and leaves focus on input
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveFocus();
  });
});


import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import FileSearch from "./FileSearch";

/** @param {unknown[]} hits @param {{ searchHold?: Promise<void> }} [options] */
function renderSearch(hits, { searchHold } = {}) {
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
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <FileSearch />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("FileSearch", () => {
  it("shows Searching and a spinner inside the results card", async () => {
    /** @type {((value?: unknown) => void) | undefined} */
    let releaseSearch;
    const searchHold = new Promise((resolve) => {
      releaseSearch = resolve;
    });
    renderSearch([], { searchHold });
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "zz" },
    });
    const searching = await screen.findByText(/Searching/i);
    expect(searching).toBeInTheDocument();
    const card = searching.closest("[data-slot=card]");
    expect(card).toBeTruthy();
    expect(card.querySelector("[data-slot=spinner]")).toBeTruthy();
    releaseSearch?.();
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument();
    expect(screen.queryByText(/Searching/i)).not.toBeInTheDocument();
  });

  it("explains an empty search in plain language", async () => {
    renderSearch([]);
    fireEvent.change(screen.getByLabelText("Search for a file"), {
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
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "beach" },
    });
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByText(/Photos Drive \/ album/i)).toBeInTheDocument();

    const open = await screen.findByRole("link", { name: /Go to folder for beach.jpg/i });
    expect(open).toHaveAttribute("href", "/drives/d1?path=album");

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
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "alb" },
    });
    const open = await screen.findByRole("link", { name: /Open album/i });
    expect(open).toHaveAttribute("href", "/drives/d1?path=album");
    const download = screen.getByRole("link", { name: /Download album/i });
    expect(download).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=album&download=1",
    );
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
    fireEvent.change(screen.getByLabelText("Search for a file"), {
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
    fireEvent.change(screen.getByLabelText("Search for a file"), {
      target: { value: "notes" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Move notes.txt to trash/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Move to trash\?/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Move to trash/i })).toBeInTheDocument();
  });
});

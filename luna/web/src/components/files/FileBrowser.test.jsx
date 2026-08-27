import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import FileBrowser from "./FileBrowser.jsx";

function stubListing(byPath) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      try {
        const parsed = new URL(u, "http://luna.test");
        if (parsed.pathname.includes("/files")) {
          const path = parsed.searchParams.get("path") || "";
          return new Response(JSON.stringify(byPath[path] || []), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch {
        // fall through
      }
      return new Response("{}", { status: 500 });
    }),
  );
}

function renderBrowser(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FileBrowser driveId="d1" driveLabel="Photos" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("FileBrowser", () => {
  it("lists folders and files with breadcrumbs", async () => {
    stubListing({
      "": [
        { name: "album", kind: "dir", size: 0, hidden: false },
        { name: "readme.txt", kind: "file", size: 1200, hidden: false },
        { name: ".secret", kind: "file", size: 1, hidden: true },
      ],
    });
    renderBrowser();
    expect(await screen.findByText("album")).toBeInTheDocument();
    expect(screen.getByText("readme.txt")).toBeInTheDocument();
    expect(screen.queryByText(".secret")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Photos" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download readme.txt/i })).toHaveAttribute(
      "href",
      expect.stringContaining("readme.txt"),
    );
  });

  it("navigates into a folder and back up", async () => {
    stubListing({
      "": [{ name: "album", kind: "dir", size: 0, hidden: false }],
      album: [{ name: "beach.jpg", kind: "file", size: 2000, hidden: false }],
    });
    renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: /album/i }));
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /↑ Up one folder/i }));
    expect(await screen.findByText("album")).toBeInTheDocument();
  });

  it("uses router links when linkNavigation is on", async () => {
    stubListing({
      "": [{ name: "album", kind: "dir", size: 0, hidden: false }],
    });
    renderBrowser({ linkNavigation: true });
    expect(await screen.findByRole("link", { name: "album" })).toHaveAttribute(
      "href",
      "/drives/d1?path=album",
    );
    expect(screen.getByRole("link", { name: "Photos" })).toHaveAttribute("href", "/drives/d1");
  });

  it("supports folder selection mode for pickers", async () => {
    const onSelect = vi.fn();
    stubListing({
      "": [
        { name: "album", kind: "dir", size: 0, hidden: false },
        { name: "note.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    renderBrowser({
      selectionMode: "folder",
      selectedPath: null,
      onSelect,
    });
    expect(await screen.findByRole("button", { name: /Select album/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select note.txt/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Select album/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        fullPath: "album",
        entry: expect.objectContaining({ name: "album", kind: "dir" }),
      }),
    );
  });

  it("calls parent action callbacks", async () => {
    const onCopy = vi.fn();
    stubListing({
      "": [{ name: "note.txt", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({ onCopy });
    fireEvent.click(await screen.findByRole("button", { name: /Copy note.txt/i }));
    expect(onCopy).toHaveBeenCalledWith(
      expect.objectContaining({ fullPath: "note.txt" }),
    );
  });

  it("shows an empty state when the folder has nothing", async () => {
    stubListing({ "": [] });
    renderBrowser();
    expect(await screen.findByText(/Nothing here yet/i)).toBeInTheDocument();
  });
});

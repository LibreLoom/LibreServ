import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("lists folders and files with a current-path label", async () => {
    stubListing({
      "": [
        { name: "album", kind: "dir", size: 0, hidden: false },
        { name: "readme.txt", kind: "file", size: 1200, hidden: false },
        { name: ".secret", kind: "file", size: 1, hidden: true },
      ],
    });
    renderBrowser({ multiSelect: false, enableDownload: true });
    expect(await screen.findByText("album")).toBeInTheDocument();
    expect(screen.getByText("readme.txt")).toBeInTheDocument();
    expect(screen.queryByText(".secret")).not.toBeInTheDocument();
    expect(screen.getByText("Current folder")).toBeInTheDocument();
    expect(screen.getAllByText("Photos").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Download readme.txt/i })).toHaveAttribute(
      "href",
      expect.stringContaining("readme.txt"),
    );
    expect(screen.getByRole("link", { name: /Download album/i })).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=album&download=1",
    );
  });

  it("navigates into a folder and back up", async () => {
    stubListing({
      "": [{ name: "album", kind: "dir", size: 0, hidden: false }],
      album: [{ name: "beach.jpg", kind: "file", size: 2000, hidden: false }],
    });
    renderBrowser({ multiSelect: false });
    fireEvent.click(await screen.findByRole("button", { name: /album/i }));
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Photos" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "album" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /↑ Up one folder/i }));
    expect(await screen.findByText("album")).toBeInTheDocument();
  });

  it("uses router links when linkNavigation is on", async () => {
    stubListing({
      "": [{ name: "album", kind: "dir", size: 0, hidden: false }],
    });
    renderBrowser({ linkNavigation: true, multiSelect: false });
    expect(await screen.findByRole("link", { name: "album" })).toHaveAttribute(
      "href",
      "/drives/d1?path=album",
    );
    expect(screen.getByRole("link", { name: "Photos" })).toHaveAttribute("href", "/drives/d1");
  });

  it("supports folder picker mode", async () => {
    const onSelect = vi.fn();
    stubListing({
      "": [
        { name: "album", kind: "dir", size: 0, hidden: false },
        { name: "note.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    renderBrowser({
      pickerMode: "folder",
      selectedPath: null,
      onSelect,
      multiSelect: false,
    });
    expect(await screen.findByRole("button", { name: /Select album/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Select note.txt/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Use this folder/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Select album/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        fullPath: "album",
        entry: expect.objectContaining({ name: "album", kind: "dir" }),
      }),
    );
  });

  it("multi-selects rows and fires bulk copy", async () => {
    const onCopy = vi.fn();
    stubListing({
      "": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
        { name: "b.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    renderBrowser({ onCopy, multiSelect: true, enableDownload: false });
    expect(await screen.findByLabelText("Select a.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select a.txt"));
    fireEvent.click(screen.getByLabelText("Select b.txt"));
    fireEvent.click(screen.getByRole("button", { name: /^Copy$/i }));
    expect(onCopy).toHaveBeenCalledWith(["a.txt", "b.txt"]);
  });

  it("calls parent action callbacks for a single row", async () => {
    const onCopy = vi.fn();
    stubListing({
      "": [{ name: "note.txt", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({ onCopy, multiSelect: false });
    fireEvent.click(await screen.findByRole("button", { name: /Copy note.txt/i }));
    expect(onCopy).toHaveBeenCalledWith(["note.txt"]);
  });

  it("exposes plain-language tooltips for row action icons", async () => {
    const user = userEvent.setup();
    stubListing({
      "": [{ name: "note.txt", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({
      onCopy: vi.fn(),
      onMove: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      multiSelect: false,
      enableDownload: false,
    });
    const copyBtn = await screen.findByRole("button", { name: "Copy note.txt" });
    // Focus opens immediately (keyboard path); hover uses the group delay.
    copyBtn.focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
    await user.hover(screen.getByRole("button", { name: "Move note.txt" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Move");
  });

  it("opens openable files via onOpenFile", async () => {
    const onOpenFile = vi.fn();
    stubListing({
      "": [{ name: "note.txt", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({ onOpenFile, multiSelect: false, enableDownload: false });
    fireEvent.click(await screen.findByRole("button", { name: /note\.txt/i }));
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ fullPath: "note.txt" }),
    );
  });

  it("shows a spinner beside the current folder while listing loads", async () => {
    /** @type {(value?: any) => void} */
    let resolveListing = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveListing = resolve;
          }),
      ),
    );
    renderBrowser({ multiSelect: false });
    expect(await screen.findByRole("status", { name: /Loading folder/i })).toBeInTheDocument();
    resolveListing(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await screen.findByText(/Nothing here yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /Loading folder/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when the folder has nothing", async () => {
    stubListing({ "": [] });
    renderBrowser({ multiSelect: false });
    expect(await screen.findByText(/Nothing here yet/i)).toBeInTheDocument();
  });

  it("shows trash as a folder row at drive root when trashHref is set", async () => {
    stubListing({
      "": [{ name: "photo.jpg", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({
      multiSelect: false,
      linkNavigation: true,
      trashHref: "/drives/d1?view=trash",
    });
    expect(await screen.findByRole("link", { name: "Trash" })).toHaveAttribute(
      "href",
      "/drives/d1?view=trash",
    );
    expect(screen.queryByRole("link", { name: /Open trash/i })).not.toBeInTheDocument();
  });

  it("selects and scrolls to a deep-linked selectPath", async () => {
    const onSelectPathApplied = vi.fn();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    stubListing({
      album: [
        { name: "a.txt", kind: "file", size: 1, hidden: false },
        { name: "beach.jpg", kind: "file", size: 2000, hidden: false },
        { name: "z.txt", kind: "file", size: 1, hidden: false },
      ],
    });
    renderBrowser({
      path: "album",
      multiSelect: true,
      selectPath: "album/beach.jpg",
      onSelectPathApplied,
    });
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    const row = document.querySelector('[data-file-path="album/beach.jpg"]');
    expect(row).toBeTruthy();
    expect(row?.className).toMatch(/bg-accent\/20/);
    expect(screen.getByLabelText("Select beach.jpg")).toBeChecked();
    expect(onSelectPathApplied).toHaveBeenCalled();
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
  });

  it("clears selection when the path changes without a select deep-link", async () => {
    stubListing({
      "": [{ name: "album", kind: "dir", size: 0, hidden: false }],
      album: [{ name: "beach.jpg", kind: "file", size: 10, hidden: false }],
    });
    function Harness() {
      const [path, setPath] = useState("");
      return (
        <>
          <button type="button" onClick={() => setPath("album")}>
            Go album
          </button>
          <FileBrowser driveId="d1" driveLabel="Photos" path={path} multiSelect />
        </>
      );
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByLabelText("Select album"));
    expect(screen.getByLabelText("Select album")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Go album" }));
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });

  it("hides trash folder row in subfolders", async () => {
    stubListing({
      album: [{ name: "beach.jpg", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({
      path: "album",
      multiSelect: false,
      linkNavigation: true,
      trashHref: "/drives/d1?view=trash",
    });
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Trash" })).not.toBeInTheDocument();
  });

  it("renders folderActions next to Upload", async () => {
    stubListing({
      "": [{ name: "photo.jpg", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({
      multiSelect: false,
      enableUploadDrop: true,
      onUploadFiles: vi.fn(),
      folderActions: <button type="button">New folder</button>,
    });
    expect(await screen.findByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload/i })).toBeInTheDocument();
  });

  it("shows folderActions in picker mode without Upload", async () => {
    stubListing({ "": [] });
    renderBrowser({
      pickerMode: "folder",
      multiSelect: false,
      enableUploadDrop: false,
      folderActions: <button type="button">New folder</button>,
    });
    expect(await screen.findByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload/i })).not.toBeInTheDocument();
  });
});

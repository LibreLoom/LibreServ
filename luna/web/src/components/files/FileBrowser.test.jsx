import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useSearchParams } from "react-router-dom";
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
  it("says the drive database is missing instead of asking to unplug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({
          error: "Luna's database for this drive is missing. The drive is still plugged in. On the Drives page, remove this drive, then add it again.",
          code: "missing_drive_db",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )),
    );
    renderBrowser();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "On the Drives page, remove this drive, then add it again.",
    );
    expect(alert).not.toHaveTextContent(/unplugg/i);
  });

  it("still asks to replug when the drive itself is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({
          error: "Luna doesn't know this drive.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )),
    );
    renderBrowser();
    expect(await screen.findByRole("alert")).toHaveTextContent(/unplugging it/i);
  });

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

  it("rounds the last file row so the accent inset hugs the card edge", async () => {
    stubListing({
      "": [
        { name: "Personal", kind: "dir", size: 0, hidden: false },
        { name: "Work", kind: "dir", size: 0, hidden: false },
      ],
    });
    renderBrowser({ multiSelect: true });
    expect(await screen.findByText("Work")).toBeInTheDocument();
    const lastRow = document.querySelector('[data-file-path="Work"]');
    expect(lastRow?.className).toMatch(/last:rounded-b-large-element/);
    const firstRow = document.querySelector('[data-file-path="Personal"]');
    expect(firstRow?.className).toMatch(/last:rounded-b-large-element/);
  });

  it("navigates into a folder and back up", async () => {
    stubListing({
      "": [{ name: "album", kind: "dir", size: 0, hidden: false }],
      album: [{ name: "beach.jpg", kind: "file", size: 2000, hidden: false }],
    });
    renderBrowser({ multiSelect: false });
    fireEvent.click(await screen.findByRole("button", { name: "album" }));
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Photos" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "album" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /↑ Up one folder/i }));
    expect(await screen.findByText("album")).toBeInTheDocument();
  });

  it("uses router links when linkNavigation is on", async () => {
    stubListing({
      "": [
        { name: "album", kind: "dir", size: 0, hidden: false },
        { name: "report.pdf", kind: "file", size: 100, hidden: false },
      ],
    });
    renderBrowser({ linkNavigation: true, multiSelect: false });
    expect(await screen.findByRole("link", { name: "album" })).toHaveAttribute(
      "href",
      "/drives/d1?path=album",
    );
    expect(screen.getByRole("link", { name: "report.pdf" })).toHaveAttribute(
      "href",
      "/drives/d1?file=report.pdf",
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
    fireEvent.click(await screen.findByRole("button", { name: "note.txt" }));
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

  it("makes file rows draggable and sets application/x-luna-paths and application/x-luna-drive on drag start", async () => {
    stubListing({
      "": [
        { name: "file1.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ onInternalMove, multiSelect: true });
    expect(await screen.findByText("file1.txt")).toBeInTheDocument();
    const row = document.querySelector('[data-file-path="file1.txt"]');
    expect(row).toBeTruthy();
    expect(row?.getAttribute("draggable")).toBe("true");
    expect(row?.className).toMatch(/cursor-grab/);

    const setData = vi.fn();
    const dataTransfer = {
      setData,
      effectAllowed: "",
      types: [],
    };
    fireEvent.dragStart(row, { dataTransfer });
    expect(setData).toHaveBeenCalledWith("application/x-luna-paths", JSON.stringify(["file1.txt"]));
    expect(setData).toHaveBeenCalledWith("application/x-luna-drive", "d1");
  });

  it("moves files into subfolder when dropped onto folder row", async () => {
    stubListing({
      "": [
        { name: "docs", kind: "dir", size: 0, hidden: false },
        { name: "report.pdf", kind: "file", size: 50, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ onInternalMove, multiSelect: true });
    expect(await screen.findByText("docs")).toBeInTheDocument();
    const folderRow = document.querySelector('[data-file-path="docs"]');
    expect(folderRow).toBeTruthy();

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (type === "application/x-luna-paths" ? JSON.stringify(["report.pdf"]) : "")),
    };
    fireEvent.dragOver(folderRow, { dataTransfer });
    expect(folderRow?.className).toMatch(/ring-accent/);

    fireEvent.drop(folderRow, { dataTransfer });
    await waitFor(() => {
      expect(onInternalMove).toHaveBeenCalledWith(["report.pdf"], "docs", undefined, undefined);
    });
  });

  it("moves files to root drive when dropped onto root breadcrumb", async () => {
    stubListing({
      "sub": [
        { name: "report.pdf", kind: "file", size: 50, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ path: "sub", onInternalMove, multiSelect: true });
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    const rootBreadcrumb = screen.getByRole("button", { name: "Photos" });

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (type === "application/x-luna-paths" ? JSON.stringify(["sub/report.pdf"]) : "")),
    };
    fireEvent.dragOver(rootBreadcrumb, { dataTransfer });
    expect(rootBreadcrumb.className).toMatch(/ring-accent/);

    fireEvent.drop(rootBreadcrumb, { dataTransfer });
    await waitFor(() => {
      expect(onInternalMove).toHaveBeenCalledWith(["sub/report.pdf"], "", undefined, undefined);
    });
  });

  it("moves files to parent path when dropped onto '↑ Up one folder'", async () => {
    stubListing({
      "sub/nested": [
        { name: "report.pdf", kind: "file", size: 50, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ path: "sub/nested", onInternalMove, multiSelect: true });
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    const upButton = screen.getByRole("button", { name: /↑ Up one folder/i });

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (type === "application/x-luna-paths" ? JSON.stringify(["sub/nested/report.pdf"]) : "")),
    };
    fireEvent.dragOver(upButton, { dataTransfer });
    expect(upButton.className).toMatch(/ring-accent/);

    fireEvent.drop(upButton, { dataTransfer });
    await waitFor(() => {
      expect(onInternalMove).toHaveBeenCalledWith(["sub/nested/report.pdf"], "sub", undefined, undefined);
    });
  });

  it("deletes files when dropped onto trash row at drive root", async () => {
    stubListing({
      "": [
        { name: "old.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const onDelete = vi.fn();
    renderBrowser({ trashHref: "/drives/d1?view=trash", onDelete, multiSelect: true });
    expect(await screen.findByText("old.txt")).toBeInTheDocument();
    const trashLink = screen.getByRole("link", { name: "Trash" });
    const trashRow = trashLink.closest("li");
    expect(trashRow).toBeTruthy();

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (type === "application/x-luna-paths" ? JSON.stringify(["old.txt"]) : "")),
    };
    fireEvent.dragOver(trashRow, { dataTransfer });
    expect(trashRow?.className).toMatch(/ring-accent/);

    fireEvent.drop(trashRow, { dataTransfer });
    expect(onDelete).toHaveBeenCalledWith(["old.txt"]);
  });

  it("fires bulk move without a destination — the picker modal chooses it", async () => {
    stubListing({
      "": [
        { name: "photo.jpg", kind: "file", size: 10, hidden: false },
      ],
    });
    const onMove = vi.fn();
    renderBrowser({ onMove, multiSelect: true });
    expect(await screen.findByLabelText("Select photo.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select photo.jpg"));

    fireEvent.click(screen.getByRole("button", { name: /^Move$/ }));
    expect(onMove).toHaveBeenCalledWith(["photo.jpg"]);
  });

  it("does not start a row drag from checkboxes or action buttons", async () => {
    stubListing({
      "": [{ name: "file1.txt", kind: "file", size: 10, hidden: false }],
    });
    const onInternalMove = vi.fn();
    renderBrowser({
      onInternalMove,
      onCopy: vi.fn(),
      multiSelect: true,
    });
    expect(await screen.findByText("file1.txt")).toBeInTheDocument();
    const setData = vi.fn();
    const dataTransfer = { setData, effectAllowed: "", types: [] };
    fireEvent.dragStart(screen.getByRole("button", { name: "Copy file1.txt" }), { dataTransfer });
    expect(setData).not.toHaveBeenCalled();
    fireEvent.dragStart(screen.getByLabelText("Select file1.txt"), { dataTransfer });
    expect(setData).not.toHaveBeenCalled();
  });

  it("moves files onto an ancestor breadcrumb segment", async () => {
    stubListing({
      "album/vacation": [
        { name: "beach.jpg", kind: "file", size: 50, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ path: "album/vacation", onInternalMove, multiSelect: true });
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    const albumCrumb = screen.getByRole("button", { name: "album" });
    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (
        type === "application/x-luna-paths" ? JSON.stringify(["album/vacation/beach.jpg"]) : ""
      )),
    };
    fireEvent.dragOver(albumCrumb, { dataTransfer });
    expect(albumCrumb.className).toMatch(/ring-accent/);
    fireEvent.drop(albumCrumb, { dataTransfer });
    await waitFor(() => {
      expect(onInternalMove).toHaveBeenCalledWith(["album/vacation/beach.jpg"], "album", undefined, undefined);
    });
  });

  it("moves files onto the current-folder breadcrumb segment, skipping items already inside", async () => {
    stubListing({
      "album": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ path: "album", onInternalMove, multiSelect: true });
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    // The last crumb is the folder being browsed — it must accept drops.
    const albumCrumb = screen.getByRole("button", { name: "album" });
    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (
        type === "application/x-luna-paths"
          ? JSON.stringify(["album/a.txt", "other/b.txt"])
          : ""
      )),
    };
    fireEvent.dragOver(albumCrumb, { dataTransfer });
    expect(albumCrumb.className).toMatch(/ring-accent/);
    fireEvent.drop(albumCrumb, { dataTransfer });
    await waitFor(() => {
      // "album/a.txt" already lives in "album" — filtered as a no-op move.
      expect(onInternalMove).toHaveBeenCalledWith(["other/b.txt"], "album", undefined, undefined);
    });

    // A drop carrying only items already inside the folder calls nothing.
    const noOpTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (
        type === "application/x-luna-paths" ? JSON.stringify(["album/a.txt"]) : ""
      )),
    };
    fireEvent.drop(albumCrumb, { dataTransfer: noOpTransfer });
    await act(async () => {});
    expect(onInternalMove).toHaveBeenCalledTimes(1);
  });

  it("moves files to the current path when dropped on the browser background", async () => {
    stubListing({
      "album": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    // No enableUploadDrop — internal drags must still land on the background.
    const { container } = renderBrowser({ path: "album", onInternalMove, multiSelect: true });
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    const browser = container.querySelector('[data-slot="file-browser"]');
    expect(browser).toBeTruthy();

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (
        type === "application/x-luna-paths"
          ? JSON.stringify(["album/a.txt", "other/b.txt"])
          : ""
      )),
    };
    fireEvent.dragOver(browser, { dataTransfer });
    fireEvent.drop(browser, { dataTransfer });
    await waitFor(() => {
      // "album/a.txt" already lives in "album" — filtered as a no-op move.
      expect(onInternalMove).toHaveBeenCalledWith(["other/b.txt"], "album", undefined, undefined);
    });
  });

  it("shows the 'Move into this folder' chip during drags from elsewhere and drops into the current folder", async () => {
    stubListing({
      "album": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    const { container } = renderBrowser({ path: "album", onInternalMove, multiSelect: true });
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    const browser = container.querySelector('[data-slot="file-browser"]');

    // No drag in flight — no chip.
    expect(screen.queryByRole("button", { name: /move them into this folder/i })).not.toBeInTheDocument();

    // A foreign drag (empty dragPathsRef — e.g. spring-loaded from another
    // drive) makes the chip appear on the first container dragover.
    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (
        type === "application/x-luna-paths" ? JSON.stringify(["other/b.txt"]) : ""
      )),
    };
    fireEvent.dragOver(browser, { dataTransfer });
    const chip = await screen.findByRole("button", { name: /move them into this folder/i });
    fireEvent.dragOver(chip, { dataTransfer });
    fireEvent.drop(chip, { dataTransfer });
    await waitFor(() => {
      expect(onInternalMove).toHaveBeenCalledWith(["other/b.txt"], "album", undefined, undefined);
    });
  });

  it("hides the chip when the dragged items already live in this folder", async () => {
    stubListing({
      "album": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ path: "album", onInternalMove, multiSelect: true });
    const row = (await screen.findByText("a.txt")).closest("li");
    const store = {};
    const dataTransfer = {
      types: [],
      effectAllowed: "",
      setData: (type, value) => {
        store[type] = value;
        dataTransfer.types.push(type);
      },
      getData: (type) => store[type] || "",
    };
    fireEvent.dragStart(row, { dataTransfer });
    // a.txt's parent is "album" — the folder being browsed — no chip.
    expect(screen.queryByRole("button", { name: /move them into this folder/i })).not.toBeInTheDocument();
    fireEvent.dragEnd(row);
  });

  it("keeps the column header inert during drags — no highlight, no drop", async () => {
    stubListing({
      "album": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const onInternalMove = vi.fn();
    const { container } = renderBrowser({ path: "album", onInternalMove, multiSelect: true });
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    const browser = container.querySelector('[data-slot="file-browser"]');
    const nameHeader = container.querySelector('[data-slot="file-browser-column-header"]');
    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (
        type === "application/x-luna-paths" ? JSON.stringify(["other/b.txt"]) : ""
      )),
    };
    fireEvent.dragOver(browser, { dataTransfer });
    expect(container.querySelector(".ring-accent")).not.toBeInTheDocument();
    fireEvent.dragEnter(nameHeader, { dataTransfer });
    fireEvent.dragOver(nameHeader, { dataTransfer });
    expect(container.querySelector(".ring-accent")).not.toBeInTheDocument();
    fireEvent.drop(nameHeader, { dataTransfer });
    await act(async () => {});
    expect(onInternalMove).not.toHaveBeenCalled();
  });

  it("spring-loads into a folder row when a drag is held over it", async () => {
    stubListing({
      "": [
        { name: "docs", kind: "dir", size: 0, hidden: false },
        { name: "report.pdf", kind: "file", size: 50, hidden: false },
      ],
      docs: [{ name: "inner.txt", kind: "file", size: 5, hidden: false }],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ onInternalMove, multiSelect: true });
    expect(await screen.findByText("docs")).toBeInTheDocument();
    const folderRow = document.querySelector('[data-file-path="docs"]');
    expect(folderRow).toBeTruthy();

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn(() => ""),
    };
    fireEvent.dragOver(folderRow, { dataTransfer });
    // Hold past the ~800 ms spring-load delay — the browser navigates into
    // docs without performing a move (no drop happened). Real timers: the
    // listing fetch + react-query notify chain does not settle on a fake
    // clock.
    expect(await screen.findByText("inner.txt", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(onInternalMove).not.toHaveBeenCalled();
  });

  it("does not spring-load when the drag leaves the folder before the delay", async () => {
    stubListing({
      "": [
        { name: "docs", kind: "dir", size: 0, hidden: false },
        { name: "report.pdf", kind: "file", size: 50, hidden: false },
      ],
      docs: [{ name: "inner.txt", kind: "file", size: 5, hidden: false }],
    });
    renderBrowser({ onInternalMove: vi.fn(), multiSelect: true });
    expect(await screen.findByText("docs")).toBeInTheDocument();
    const folderRow = document.querySelector('[data-file-path="docs"]');

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn(() => ""),
    };
    fireEvent.dragOver(folderRow, { dataTransfer });
    fireEvent.dragLeave(folderRow, { dataTransfer, relatedTarget: document.body });
    // Wait past the spring-load delay — leaving first must have cancelled it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    // Still at drive root — no navigation happened.
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.queryByText("inner.txt")).not.toBeInTheDocument();
  });

  it("still drops into a folder on a quick drop without navigating", async () => {
    stubListing({
      "": [
        { name: "docs", kind: "dir", size: 0, hidden: false },
        { name: "report.pdf", kind: "file", size: 50, hidden: false },
      ],
      docs: [{ name: "inner.txt", kind: "file", size: 5, hidden: false }],
    });
    const onInternalMove = vi.fn();
    renderBrowser({ onInternalMove, multiSelect: true });
    expect(await screen.findByText("docs")).toBeInTheDocument();
    const folderRow = document.querySelector('[data-file-path="docs"]');

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn((type) => (
        type === "application/x-luna-paths" ? JSON.stringify(["report.pdf"]) : ""
      )),
    };
    // Drag over and drop immediately — well under the spring-load delay.
    fireEvent.dragOver(folderRow, { dataTransfer });
    fireEvent.drop(folderRow, { dataTransfer });
    await waitFor(() => {
      expect(onInternalMove).toHaveBeenCalledWith(["report.pdf"], "docs", undefined, undefined);
    });
    // A quick drop moves into the folder but does not navigate into it.
    expect(screen.getByText("docs")).toBeInTheDocument();
    expect(screen.queryByText("inner.txt")).not.toBeInTheDocument();
  });

  it("spring-loads to an ancestor breadcrumb segment when a drag is held over it", async () => {
    stubListing({
      "album/vacation": [
        { name: "beach.jpg", kind: "file", size: 50, hidden: false },
      ],
      album: [{ name: "photo.jpg", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({
      initialPath: "album/vacation",
      onInternalMove: vi.fn(),
      multiSelect: true,
    });
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    const albumCrumb = screen.getByRole("button", { name: "album" });
    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn(() => ""),
    };
    fireEvent.dragOver(albumCrumb, { dataTransfer });
    expect(await screen.findByText("photo.jpg", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("spring-loads via router navigation when linkNavigation is on", async () => {
    stubListing({
      "": [{ name: "docs", kind: "dir", size: 0, hidden: false }],
      docs: [{ name: "inner.txt", kind: "file", size: 5, hidden: false }],
    });
    const onInternalMove = vi.fn();
    function Harness() {
      const [searchParams] = useSearchParams();
      return (
        <>
          <output data-testid="path-echo">{searchParams.get("path") || "root"}</output>
          <FileBrowser
            driveId="d1"
            driveLabel="Photos"
            path={searchParams.get("path") || ""}
            linkNavigation
            multiSelect
            onInternalMove={onInternalMove}
          />
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
    expect(await screen.findByText("docs")).toBeInTheDocument();
    const folderRow = document.querySelector('[data-file-path="docs"]');
    expect(folderRow).toBeTruthy();

    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn(() => ""),
    };
    fireEvent.dragOver(folderRow, { dataTransfer });
    // The router URL carries the new folder, same as a normal link click.
    await waitFor(
      () => expect(screen.getByTestId("path-echo")).toHaveTextContent("docs"),
      { timeout: 3000 },
    );
    expect(await screen.findByText("inner.txt")).toBeInTheDocument();
    expect(onInternalMove).not.toHaveBeenCalled();
  });

  it("in trash shows pre-trash names and crumb labels", async () => {
    stubListing({
      ".luna-trash": [
        {
          name: "171-photo.jpg",
          original_name: "photo.jpg",
          original_path: "photo.jpg",
          kind: "file",
          size: 12,
          modified: 0,
          hidden: false,
        },
      ],
    });
    renderBrowser({
      path: ".luna-trash",
      segmentLabel: (segment, i) => (i === 0 ? "Trash" : segment),
      multiSelect: false,
      linkNavigation: true,
    });
    expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
    expect(screen.queryByText("171-photo.jpg")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trash" })).toHaveAttribute(
      "href",
      "/drives/d1?path=.luna-trash",
    );
    // Up one folder returns to the drive root.
    expect(screen.getByRole("link", { name: "↑ Up one folder" })).toHaveAttribute(
      "href",
      "/drives/d1",
    );
  });

  it("in trash has no checkboxes but renders the caller's row actions", async () => {
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    stubListing({
      ".luna-trash": [
        {
          name: "171-photo.jpg",
          original_name: "photo.jpg",
          original_path: "photo.jpg",
          kind: "file",
          size: 12,
          modified: 0,
          hidden: false,
        },
      ],
    });
    renderBrowser({
      path: ".luna-trash",
      multiSelect: true,
      renderRowActions: (ctx) => (
        <>
          <button type="button" onClick={() => onRestore(ctx)}>
            {`Restore ${ctx.displayName}`}
          </button>
          <button type="button" onClick={() => onPurge(ctx)}>
            {`Delete ${ctx.displayName} permanently`}
          </button>
        </>
      ),
    });
    expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
    // Trash rows are never selectable — no row or select-all checkboxes.
    expect(screen.queryByLabelText("Select photo.jpg")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select all in this folder")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore photo.jpg" }));
    expect(onRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        fullPath: ".luna-trash/171-photo.jpg",
        displayName: "photo.jpg",
        entry: expect.objectContaining({ name: "171-photo.jpg" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete photo.jpg permanently" }));
    expect(onPurge).toHaveBeenCalledWith(
      expect.objectContaining({ fullPath: ".luna-trash/171-photo.jpg" }),
    );
  });

  it("hands row contexts to renderSelectionActions", async () => {
    const onAct = vi.fn();
    stubListing({
      "": [{ name: "a.txt", kind: "file", size: 1, hidden: false }],
    });
    renderBrowser({
      multiSelect: true,
      renderSelectionActions: (paths, rows) => (
        <button type="button" onClick={() => onAct(rows)}>
          Act on them
        </button>
      ),
    });
    fireEvent.click(await screen.findByLabelText("Select a.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Act on them" }));
    expect(onAct).toHaveBeenCalledWith([
      expect.objectContaining({ fullPath: "a.txt", displayName: "a.txt" }),
    ]);
  });

  it("in trash does not drag rows, accept drops, or open session-backed files", async () => {
    const onOpenFile = vi.fn();
    const onInternalMove = vi.fn();
    stubListing({
      ".luna-trash": [
        {
          name: "171-docs",
          original_name: "docs",
          original_path: "docs",
          kind: "dir",
          size: 0,
          modified: 0,
          hidden: false,
        },
        {
          name: "171-doc.docx",
          original_name: "doc.docx",
          original_path: "doc.docx",
          kind: "file",
          size: 12,
          modified: 0,
          hidden: false,
        },
        {
          name: "171-note.txt",
          original_name: "note.txt",
          original_path: "note.txt",
          kind: "file",
          size: 12,
          modified: 0,
          hidden: false,
        },
      ],
    });
    renderBrowser({
      path: ".luna-trash",
      onOpenFile,
      onInternalMove,
      multiSelect: true,
    });
    expect(await screen.findByText("doc.docx")).toBeInTheDocument();
    // Office files need an edit session trash can't provide — not openable.
    expect(screen.queryByRole("button", { name: "doc.docx" })).not.toBeInTheDocument();
    // Text files still preview read-only.
    fireEvent.click(screen.getByRole("button", { name: "note.txt" }));
    expect(onOpenFile).toHaveBeenCalledWith(
      expect.objectContaining({ fullPath: ".luna-trash/171-note.txt" }),
    );
    // Rows don't drag, and trash folders aren't drop targets.
    const noteRow = document.querySelector('[data-file-path=".luna-trash/171-note.txt"]');
    expect(noteRow?.getAttribute("draggable")).not.toBe("true");
    const setData = vi.fn();
    fireEvent.dragStart(noteRow, { dataTransfer: { setData, effectAllowed: "", types: [] } });
    expect(setData).not.toHaveBeenCalled();
    const dirRow = document.querySelector('[data-file-path=".luna-trash/171-docs"]');
    const dataTransfer = {
      types: ["application/x-luna-paths"],
      getData: vi.fn(() => JSON.stringify(["other/x.txt"])),
    };
    fireEvent.dragOver(dirRow, { dataTransfer });
    fireEvent.drop(dirRow, { dataTransfer });
    await act(async () => {});
    expect(onInternalMove).not.toHaveBeenCalled();
  });
});

describe("FileBrowser folder chrome auto-split", () => {
  /** @type {ResizeObserverCallback[]} */
  let observers = [];
  /** @type {{ clientWidth: number, scrollWidth: number }} */
  let defaultContainer;
  /** @type {{ clientWidth: number, scrollWidth: number }} */
  let defaultProbe;

  beforeEach(() => {
    observers = [];
    defaultContainer = { clientWidth: 900, scrollWidth: 900 };
    defaultProbe = { clientWidth: 200, scrollWidth: 200 };

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        if (this.getAttribute?.("data-slot")?.startsWith("file-browser-folder-chrome")) {
          return defaultContainer.clientWidth;
        }
        if (this.parentElement?.getAttribute?.("aria-hidden") === "true") {
          return defaultProbe.clientWidth;
        }
        return 800;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        if (this.parentElement?.getAttribute?.("aria-hidden") === "true") {
          return defaultProbe.scrollWidth;
        }
        if (this.getAttribute?.("data-slot")?.startsWith("file-browser-folder-chrome")) {
          return defaultContainer.scrollWidth;
        }
        return 800;
      },
    });

    globalThis.ResizeObserver = class {
      /** @param {ResizeObserverCallback} cb */
      constructor(cb) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error cleanup test polyfill
    delete HTMLElement.prototype.clientWidth;
    // @ts-expect-error cleanup test polyfill
    delete HTMLElement.prototype.scrollWidth;
  });

  it("keeps New/Upload in the current-folder card when they fit", async () => {
    stubListing({ "": [] });
    defaultContainer = { clientWidth: 900, scrollWidth: 900 };
    defaultProbe = { clientWidth: 200, scrollWidth: 200 };

    const { container } = renderBrowser({
      multiSelect: false,
      enableUploadDrop: true,
      onUploadFiles: vi.fn(),
      folderActions: <button type="button">New</button>,
    });

    expect(await screen.findByRole("button", { name: "New" })).toBeInTheDocument();

    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(60);
      observers.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });

    expect(container.querySelector("[data-slot=file-browser-folder-chrome-combined]")).toBeTruthy();
    expect(container.querySelector("[data-slot=file-browser-folder-chrome-split]")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Folder actions" })).not.toBeInTheDocument();
  });

  it("moves New/Upload into a toolbar below the card when they do not fit", async () => {
    stubListing({ "": [] });
    defaultContainer = { clientWidth: 280, scrollWidth: 280 };
    defaultProbe = { clientWidth: 500, scrollWidth: 500 };

    const { container } = renderBrowser({
      multiSelect: false,
      enableUploadDrop: true,
      onUploadFiles: vi.fn(),
      folderActions: <button type="button">New</button>,
    });

    expect(await screen.findByRole("button", { name: "New" })).toBeInTheDocument();

    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(60);
      observers.forEach((cb) => cb([], /** @type {ResizeObserver} */ ({})));
    });

    expect(container.querySelector("[data-slot=file-browser-folder-chrome-split]")).toBeTruthy();
    expect(container.querySelector("[data-slot=file-browser-folder-chrome-combined]")).toBeNull();
    const toolbar = screen.getByRole("toolbar", { name: "Folder actions" });
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "New" }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: /Upload/i }));
  });

  it("clips the measure probe so it cannot widen page scroll", async () => {
    stubListing({ "": [] });
    const { container } = renderBrowser({
      multiSelect: false,
      enableUploadDrop: true,
      onUploadFiles: vi.fn(),
      folderActions: <button type="button">New</button>,
    });
    expect(await screen.findByRole("button", { name: "New" })).toBeInTheDocument();
    const probe = container.querySelector("[data-slot=file-browser-folder-chrome-probe]");
    expect(probe).toBeTruthy();
    expect(probe?.className).toMatch(/\bw-0\b/);
    expect(probe?.className).toMatch(/overflow-hidden/);
    expect(
      container.querySelector("[data-slot=file-browser-folder-chrome-combined]")?.className,
    ).not.toMatch(/overflow-x-hidden|overflow-hidden/);
  });
});

describe("FileBrowser sorting and filtering", () => {
  afterEach(() => {
    window.localStorage.removeItem("luna.files.sort");
  });

  function rowPaths() {
    return [...document.querySelectorAll("[data-file-path]")]
      .map((row) => row.getAttribute("data-file-path"));
  }

  async function pickSort(label) {
    fireEvent.click(screen.getByRole("button", { name: "Sort files" }));
    fireEvent.click(await screen.findByRole("option", { name: label }));
  }

  it("shows view controls instead of column labels", async () => {
    stubListing({
      "": [{ name: "a.txt", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({ multiSelect: true });
    await screen.findByText("a.txt");
    expect(screen.queryByText("Size")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Find in this folder")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Show" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort files" })).toBeInTheDocument();
  });

  it("clips the sort menu horizontally so hover slides cannot scroll it", async () => {
    stubListing({
      "": [{ name: "a.txt", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({ multiSelect: true });
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Sort files" }));
    const menu = await screen.findByRole("listbox");
    expect(menu.className).toMatch(/overflow-x-hidden/);
  });

  it("sorts rows by name, size, and date with folders on top", async () => {
    stubListing({
      "": [
        { name: "z.txt", kind: "file", size: 100, modified: 100, hidden: false },
        { name: "a.txt", kind: "file", size: 10, modified: 300, hidden: false },
        { name: "top", kind: "dir", size: 0, modified: 200, hidden: false },
        { name: "m.txt", kind: "file", size: 500, modified: 200, hidden: false },
      ],
    });
    renderBrowser({ multiSelect: true });
    await screen.findByText("a.txt");
    // Default: Name A–Z, folders first.
    expect(rowPaths()).toEqual(["top", "a.txt", "m.txt", "z.txt"]);

    await pickSort("Name Z–A");
    expect(rowPaths()).toEqual(["top", "z.txt", "m.txt", "a.txt"]);

    await pickSort("Largest first");
    expect(rowPaths()).toEqual(["top", "m.txt", "z.txt", "a.txt"]);

    await pickSort("Newest first");
    expect(rowPaths()).toEqual(["top", "a.txt", "m.txt", "z.txt"]);
  });

  it("sorts files by extension for the File type option", async () => {
    stubListing({
      "": [
        { name: "b.png", kind: "file", size: 1, hidden: false },
        { name: "a.jpg", kind: "file", size: 1, hidden: false },
        { name: "c.png", kind: "file", size: 1, hidden: false },
      ],
    });
    renderBrowser({ multiSelect: true });
    await screen.findByText("a.jpg");
    await pickSort("File type");
    expect(rowPaths()).toEqual(["a.jpg", "b.png", "c.png"]);
  });

  it("remembers the chosen sort across mounts", async () => {
    stubListing({
      "": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
        { name: "z.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    const first = renderBrowser({ multiSelect: true });
    await screen.findByText("a.txt");
    await pickSort("Name Z–A");
    expect(rowPaths()).toEqual(["z.txt", "a.txt"]);
    first.unmount();

    renderBrowser({ multiSelect: true });
    await screen.findByText("a.txt");
    expect(rowPaths()).toEqual(["z.txt", "a.txt"]);
  });

  it("filters rows by name, shows a count, and clears", async () => {
    stubListing({
      "": [
        { name: "beach.jpg", kind: "file", size: 10, hidden: false },
        { name: "notes.txt", kind: "file", size: 10, hidden: false },
        { name: "album", kind: "dir", size: 0, hidden: false },
      ],
    });
    renderBrowser({ multiSelect: true });
    const input = await screen.findByLabelText("Find in this folder");
    fireEvent.change(input, { target: { value: "bea" } });

    expect(screen.getByText("beach.jpg")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
    expect(screen.queryByText("album")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear the folder filter" }));
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.queryByText("1 of 3")).not.toBeInTheDocument();
  });

  it("filters by kind with the All / Folders / Files control", async () => {
    stubListing({
      "": [
        { name: "album", kind: "dir", size: 0, hidden: false },
        { name: "beach.jpg", kind: "file", size: 10, hidden: false },
      ],
    });
    renderBrowser({ multiSelect: true });
    await screen.findByText("beach.jpg");

    fireEvent.click(screen.getByRole("radio", { name: "Folders" }));
    expect(screen.queryByText("beach.jpg")).not.toBeInTheDocument();
    expect(screen.getByText("album")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Files" }));
    expect(screen.getByText("beach.jpg")).toBeInTheDocument();
    expect(screen.queryByText("album")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByText("album")).toBeInTheDocument();
    expect(screen.getByText("beach.jpg")).toBeInTheDocument();
  });

  it("shows a filtered-empty state and Show everything restores the list", async () => {
    stubListing({
      "": [{ name: "beach.jpg", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({ multiSelect: true });
    const input = await screen.findByLabelText("Find in this folder");
    fireEvent.change(input, { target: { value: "zzz" } });

    expect(await screen.findByText('Nothing matches "zzz" in this folder')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show everything" }));
    expect(screen.getByText("beach.jpg")).toBeInTheDocument();
  });

  it("shows a kind-filter empty state", async () => {
    stubListing({
      "": [{ name: "beach.jpg", kind: "file", size: 10, hidden: false }],
    });
    renderBrowser({ multiSelect: true });
    await screen.findByText("beach.jpg");
    fireEvent.click(screen.getByRole("radio", { name: "Folders" }));
    expect(await screen.findByText("No folders in this folder")).toBeInTheDocument();
  });

  it("clears the name filter when navigating into another folder", async () => {
    stubListing({
      "": [
        { name: "sub", kind: "dir", size: 0, hidden: false },
        { name: "aaa.txt", kind: "file", size: 10, hidden: false },
      ],
      sub: [{ name: "inner.txt", kind: "file", size: 5, hidden: false }],
    });
    renderBrowser({ multiSelect: true });
    const input = await screen.findByLabelText("Find in this folder");
    // "s" keeps the "sub" row visible while hiding aaa.txt.
    fireEvent.change(input, { target: { value: "s" } });
    expect(screen.queryByText("aaa.txt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "sub" }));
    expect(await screen.findByText("inner.txt")).toBeInTheDocument();
    expect(screen.getByLabelText("Find in this folder")).toHaveValue("");
    expect(screen.getByText("inner.txt")).toBeInTheDocument();
  });

  it("select-all covers only the filtered rows", async () => {
    stubListing({
      "": [
        { name: "a.txt", kind: "file", size: 10, hidden: false },
        { name: "b.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    renderBrowser({ multiSelect: true });
    const input = await screen.findByLabelText("Find in this folder");
    fireEvent.change(input, { target: { value: "a" } });

    fireEvent.click(screen.getByLabelText("Select all in this folder"));
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
    expect(screen.getByLabelText("Select a.txt")).toBeChecked();
  });

  it("opens a properties modal with details instead of inline columns", async () => {
    const modified = 1700000000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const parsed = new URL(String(url), "http://luna.test");
        if (parsed.pathname.endsWith("/files/stat")) {
          return new Response(
            JSON.stringify({
              name: "old.txt",
              kind: "file",
              size: 1234,
              modified,
              created: modified - 100,
              hidden: false,
              writable: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (parsed.pathname.includes("/files")) {
          const path = parsed.searchParams.get("path") || "";
          const listing = {
            "": [{ name: "old.txt", kind: "file", size: 1234, modified, hidden: false }],
          };
          return new Response(JSON.stringify(listing[path] || []), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      }),
    );
    renderBrowser({ multiSelect: true });
    await screen.findByText("old.txt");
    // Details moved out of the row into the dedicated modal.
    expect(screen.queryByText("1.2 KB")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Properties for old.txt/i }));
    const dialog = await screen.findByRole("dialog");
    // Headline stat: human size up top, exact bytes underneath.
    expect(await within(dialog).findByText("Size")).toBeInTheDocument();
    expect(within(dialog).getByText("1.2 KB")).toBeInTheDocument();
    expect(within(dialog).getByText("1,234 bytes")).toBeInTheDocument();
    // Type appears in the hero pill and the Details row.
    expect(within(dialog).getAllByText("Text file (.txt)").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Details")).toBeInTheDocument();
    expect(within(dialog).getByText("Activity")).toBeInTheDocument();
    expect(within(dialog).getByText("Last changed")).toBeInTheDocument();
    // Access is a status pill now, not a table row.
    expect(within(dialog).getByText("View and change")).toBeInTheDocument();
  });

  it("shows a folder's recursive totals in the properties modal", async () => {
    const modified = 1700000000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const parsed = new URL(String(url), "http://luna.test");
        if (parsed.pathname.endsWith("/files/stat")) {
          return new Response(
            JSON.stringify({
              name: "album",
              kind: "dir",
              size: 4096,
              modified,
              hidden: false,
              writable: false,
              children: { dirs: 1, files: 2, other: 0 },
              totals: { bytes: 12500, dirs: 3, files: 8, other: 1, complete: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (parsed.pathname.includes("/files")) {
          const path = parsed.searchParams.get("path") || "";
          const listing = {
            "": [{ name: "album", kind: "dir", size: 0, modified, hidden: false }],
          };
          return new Response(JSON.stringify(listing[path] || []), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      }),
    );
    renderBrowser({ multiSelect: true });
    await screen.findByText("album");
    fireEvent.click(screen.getByRole("button", { name: /Properties for album/i }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Total size")).toBeInTheDocument();
    expect(within(dialog).getByText("12.5 KB")).toBeInTheDocument();
    expect(within(dialog).getByText("12,500 bytes altogether")).toBeInTheDocument();
    expect(within(dialog).getByText("3")).toBeInTheDocument();
    expect(within(dialog).getByText("8")).toBeInTheDocument();
    expect(within(dialog).getByText("files")).toBeInTheDocument();
    expect(within(dialog).getByText("folders")).toBeInTheDocument();
    expect(within(dialog).getByText("View only")).toBeInTheDocument();
  });

  it("marks an unfinished folder count as a lower bound, not a failure", async () => {
    const modified = 1700000000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const parsed = new URL(String(url), "http://luna.test");
        if (parsed.pathname.endsWith("/files/stat")) {
          return new Response(
            JSON.stringify({
              name: "big",
              kind: "dir",
              size: 4096,
              modified,
              hidden: false,
              writable: true,
              children: { dirs: 1, files: 2, other: 0 },
              totals: { bytes: 12500, dirs: 3, files: 8, other: 0, complete: false },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (parsed.pathname.includes("/files")) {
          const path = parsed.searchParams.get("path") || "";
          const listing = {
            "": [{ name: "big", kind: "dir", size: 0, modified, hidden: false }],
          };
          return new Response(JSON.stringify(listing[path] || []), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      }),
    );
    renderBrowser({ multiSelect: true });
    await screen.findByText("big");
    fireEvent.click(screen.getByRole("button", { name: /Properties for big/i }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("≥ 12.5 KB")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/at least 12,500 bytes/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("8+")).toBeInTheDocument();
    // Never claims the folder was too big to count.
    expect(within(dialog).queryByText(/too much inside to count the total size/)).not.toBeInTheDocument();
  });

  it("shows the view controls in picker mode without the select-all checkbox", async () => {
    stubListing({
      "": [
        { name: "album", kind: "dir", size: 0, hidden: false },
        { name: "note.txt", kind: "file", size: 10, hidden: false },
      ],
    });
    renderBrowser({ pickerMode: "folder", multiSelect: false, onSelect: vi.fn() });
    await screen.findByText("album");
    expect(screen.getByLabelText("Find in this folder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort files" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Select all in this folder")).not.toBeInTheDocument();
  });
});

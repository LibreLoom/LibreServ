import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import FilesPage from "./FilesPage";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";

function filesPath(url) {
  try {
    return new URL(String(url), "http://luna.test").searchParams.get("path") || "";
  } catch {
    return "";
  }
}

function stubFilesApi(byPath) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    if (u.endsWith("/drives")) {
      return new Response(JSON.stringify(byPath.__drives || [
        { id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz", mount_point: "/x" },
        { id: "d2", label: "Spare Drive", state: "as_is", fs_type: "ext4", device: "sdy", mount_point: "/y" },
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/connect/status")) {
      return new Response(JSON.stringify({
        backup_unlocked: Boolean(byPath.__backupUnlocked),
        backup_sources: byPath.__backupSources || [],
        connect_active: Boolean(byPath.__backupUnlocked),
        enabled: Boolean(byPath.__backupUnlocked),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/auth/me") || u.endsWith("/api/v1/auth/me")) {
      return new Response(JSON.stringify({
        id: byPath.__userId || "1",
        role: byPath.__role || "admin",
        username: byPath.__role === "user" ? "sam" : "admin",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/jobs")) {
      return new Response(JSON.stringify(byPath.__jobs || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/search")) {
      return new Response(JSON.stringify(byPath.__search || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/trash")) {
      return new Response(JSON.stringify(byPath.__trash || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/files/mkdir") && method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      const full = String(body.path || "");
      const parent = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
      const name = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;
      byPath[parent] = [
        ...(byPath[parent] || []),
        { name, kind: "dir", size: 0, modified: 0, hidden: false },
      ];
      return new Response(JSON.stringify({ ok: true, path: full }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/files/create") && method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      const full = String(body.path || "");
      const parent = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
      const name = full.includes("/") ? full.slice(full.lastIndexOf("/") + 1) : full;
      byPath[parent] = [
        ...(byPath[parent] || []),
        { name, kind: "file", size: 0, modified: 0, hidden: false },
      ];
      return new Response(JSON.stringify({ ok: true, path: full }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/files/content")) {
      return new Response("", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (u.includes("/files/upload")) {
      return new Response(JSON.stringify({ name: "note.txt" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/files?") && method === "DELETE") {
      if (byPath.__deleteFail) {
        return new Response(JSON.stringify({ error: "Luna couldn't move that to Trash. Try again." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/files/stat")) {
      const path = filesPath(u);
      const stat = byPath.__stat?.[path] ?? {
        name: path.split("/").pop() || "Photos Drive",
        kind: "dir",
        size: 0,
        modified: 0,
        writable: true,
        trashed_from: null,
      };
      return new Response(JSON.stringify(stat), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/files?")) {
      const p = filesPath(u);
      if (byPath.__errors?.[p]) {
        return new Response(
          JSON.stringify({ error: byPath.__errors[p].message || "Forbidden" }),
          { status: byPath.__errors[p].status, headers: { "Content-Type": "application/json" } },
        );
      }
      const listing = byPath[p] ?? [];
      return new Response(JSON.stringify(listing), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/users") || u.includes("/users/directory")) {
      return new Response(JSON.stringify(byPath.__users || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/me/access")) {
      return new Response(JSON.stringify(byPath.__access || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/access/subject")) {
      const parsed = new URL(u, "http://luna.test");
      const path = parsed.searchParams.get("path") || "";
      return new Response(JSON.stringify({
        subject: {
          kind: "path",
          drive_id: parsed.searchParams.get("drive_id") || "d1",
          path,
          album_id: "",
          is_file: Boolean(byPath.__subjectIsFile),
          exists: true,
          name: path.split("/").pop() || "Photos Drive",
        },
        // The stub user is an admin — the API hands them manage caps
        // (content + the share bit), not bare "full".
        my_caps: byPath.__myCaps || "full+share",
        members: byPath.__members || [],
        links: byPath.__links || [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/access/links") && method === "POST") {
      if (byPath.__postLink) return byPath.__postLink(String(init.body || ""));
      return new Response(JSON.stringify({ error: "Luna can't find that file or folder." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderFiles(path = "/drives/d1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes><Route path="/drives/:id" element={<FilesPage />} /></Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
    </ToastProvider>
  );
}

describe("FilesPage", () => {
  it("shows upload control and folder contents", async () => {
    stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    expect(await screen.findByRole("button", { name: /Upload/i })).toBeInTheDocument();
    expect(await screen.findByText(/photo.jpg/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trash" })).toHaveAttribute("href", "/drives/d1?path=.luna-trash");
    expect(screen.queryByRole("link", { name: /Open trash/i })).not.toBeInTheDocument();
    expect(screen.getAllByText("Current folder").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Sharing for photo.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect photo.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protect Photos Drive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Share this folder/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Open as a folder on a computer/i })).not.toBeInTheDocument();
  });

  it("shows only the upload surface for an upload-only member grant", async () => {
    stubFilesApi({
      __role: "user",
      __access: [
        { id: "g1", kind: "path", drive_id: "d1", path: "", caps: "upload", name: "Photos Drive" },
      ],
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    expect(await screen.findByText("Upload files")).toBeInTheDocument();
    expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Find in this folder")).not.toBeInTheDocument();
  });

  it("lands an upload-only member on the upload surface with no list/stat calls", async () => {
    const fetchMock = stubFilesApi({
      __role: "user",
      __access: [
        { id: "g1", kind: "path", drive_id: "d1", path: "docs/drop", caps: "upload", name: "drop" },
      ],
    });
    renderFiles("/drives/d1?path=docs%2Fdrop");
    expect(await screen.findByText("Upload files")).toBeInTheDocument();
    // list and stat would both 403 for an upload-only grant — never fire them.
    expect(fetchMock.mock.calls.some(([u]) =>
      String(u).includes("/files?") || String(u).includes("/files/stat"))).toBe(false);
  });

  it("lands a member file grant on the file itself as a virtual root", async () => {
    stubFilesApi({
      __role: "user",
      __access: [
        {
          id: "g1", kind: "path", drive_id: "d1", path: "docs/report.txt",
          caps: "view", name: "report.txt", is_file: true,
        },
      ],
      "docs/report.txt": [
        { name: "report.txt", kind: "file", size: 10, modified: 0, hidden: false },
      ],
      __stat: {
        "docs/report.txt": {
          name: "report.txt", kind: "file", size: 10, modified: 0,
          writable: false, trashed_from: null,
        },
      },
    });
    renderFiles("/drives/d1?path=docs%2Freport.txt");
    // The row maps back onto the granted path — not a doubled joinPath.
    await waitFor(() => {
      expect(document.querySelector('[data-file-path="docs/report.txt"]')).toBeTruthy();
    });
    // The grant is the virtual root: its basename is the only crumb, no Up,
    // and nothing links to the parent folder or the drive root.
    expect(screen.queryByRole("link", { name: "docs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Photos Drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /↑ Up one folder/i })).not.toBeInTheDocument();
    const rowLinks = screen.getAllByRole("link", { name: "report.txt" });
    expect(rowLinks.some((a) =>
      a.getAttribute("href") === "/drives/d1?path=docs%2Freport.txt")).toBe(true);
  });

  it("floors a member's breadcrumbs and Up at the granted folder", async () => {
    stubFilesApi({
      __role: "user",
      __access: [
        { id: "g1", kind: "path", drive_id: "d1", path: "docs", caps: "view", name: "docs" },
      ],
      "docs/reports": [
        { name: "q1.txt", kind: "file", size: 10, modified: 0, hidden: false },
      ],
    });
    renderFiles("/drives/d1?path=docs%2Freports");
    expect(await screen.findByText("q1.txt")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Photos Drive" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" }))
      .toHaveAttribute("href", "/drives/d1?path=docs");
    expect(screen.getByRole("link", { name: "reports" }))
      .toHaveAttribute("href", "/drives/d1?path=docs%2Freports");
    expect(screen.getByRole("link", { name: /↑ Up one folder/i }))
      .toHaveAttribute("href", "/drives/d1?path=docs");
  });

  it("points a member at Shared when the browsed folder isn't granted", async () => {
    stubFilesApi({
      __role: "user",
      __access: [
        { id: "g1", kind: "path", drive_id: "d1", path: "docs", caps: "view", name: "docs" },
      ],
      __errors: { "": { status: 403, message: "You don't have permission to view this folder." } },
    });
    renderFiles();
    expect(await screen.findByText("You don't have access to this folder")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Shared" }))
      .toHaveAttribute("href", "/shared");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a drive menu when more than one drive is ready", async () => {
    stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    const trigger = await screen.findByRole("button", { name: "Places: Photos Drive" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Places" });
    // The drive being browsed sits on the trigger, not in the list.
    expect(within(menu).queryByRole("menuitem", { name: "Photos Drive" })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Spare Drive" }));
    expect(await screen.findByRole("heading", { name: "Spare Drive" })).toBeInTheDocument();
  });

  it("moves dragged files to another drive's root from the drive menu", async () => {
    const fetchMock = stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Places: Photos Drive" }));
    const item = await screen.findByRole("menuitem", { name: "Spare Drive" });
    const dataTransfer = {
      types: ["application/x-luna-paths"],
      dropEffect: "",
      getData: (type) =>
        type === "application/x-luna-paths" ? JSON.stringify(["photo.jpg"])
        : type === "application/x-luna-drive" ? "d1"
        : "",
    };
    fireEvent.dragOver(item, { dataTransfer });
    fireEvent.drop(item, { dataTransfer });
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/api/v1/jobs") && (init?.method || "GET").toUpperCase() === "POST"
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post[1].body))).toEqual({
        kind: "move",
        from_drive: "d1",
        from_path: "photo.jpg",
        to_drive: "d2",
        to_path: "",
      });
    });
    // The drop must not navigate — the browser stays on the current drive.
    expect(screen.getByRole("heading", { name: "Photos Drive" })).toBeInTheDocument();
  });

  it("shows a separate Protect button for folders", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
    });
    renderFiles();
    expect(await screen.findByText(/album/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sharing for album" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protect album" })).toBeInTheDocument();
  });

  it("hides Protect with one drive and no cloud backup", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
      __drives: [
        { id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz", mount_point: "/x" },
      ],
      __backupUnlocked: false,
    });
    renderFiles();
    expect(await screen.findByText(/album/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect album" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect Photos Drive" })).not.toBeInTheDocument();
  });

  it("shows Protect with one drive when cloud backup is connected", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
      __drives: [
        { id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz", mount_point: "/x" },
      ],
      __backupUnlocked: true,
    });
    renderFiles();
    expect(await screen.findByRole("button", { name: "Protect album" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protect Photos Drive" })).toBeInTheDocument();
  });

  it("offers download for files and folders in the row toolbar", async () => {
    stubFilesApi({
      "": [
        { name: "album", kind: "dir", size: 0, modified: 0, hidden: false },
        { name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false },
      ],
    });
    renderFiles();
    expect(await screen.findByText(/photo.jpg/i)).toBeInTheDocument();
    const fileDownload = screen.getByRole("link", { name: "Download photo.jpg" });
    expect(fileDownload).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=photo.jpg&download=1",
    );
    const folderDownload = screen.getByRole("link", { name: "Download album" });
    expect(folderDownload).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=album&download=1",
    );
    expect(screen.getByRole("link", { name: "Download Photos Drive" })).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=&download=1",
    );
  });

  it("opens a folder from the address bar and keeps the address in sync", async () => {
    stubFilesApi({
      album: [{ name: "vacation", kind: "dir", size: 0, modified: 0, hidden: false }],
      "album/vacation": [{ name: "beach.jpg", kind: "file", size: 2000, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1?path=album");

    expect(await screen.findByRole("link", { name: "vacation" })).toHaveAttribute(
      "href",
      "/drives/d1?path=album%2Fvacation",
    );
    expect(screen.getByRole("link", { name: "↑ Up one folder" })).toHaveAttribute("href", "/drives/d1");
    // Breadcrumb root link back to the drive's top level.
    const rootCrumb = screen.getByRole("link", { name: "Photos Drive" });
    expect(rootCrumb).toHaveAttribute("href", "/drives/d1");
    expect(screen.getByRole("link", { name: "album" })).toHaveAttribute("href", "/drives/d1?path=album");

    fireEvent.click(screen.getByRole("link", { name: "vacation" }));
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "↑ Up one folder" })).toHaveAttribute(
      "href",
      "/drives/d1?path=album",
    );
  });

  it("selects a file from the select query param", async () => {
    stubFilesApi({
      album: [
        { name: "a.txt", kind: "file", size: 1, modified: 0, hidden: false },
        { name: "beach.jpg", kind: "file", size: 2000, modified: 0, hidden: false },
      ],
    });
    renderFiles("/drives/d1?path=album&select=album%2Fbeach.jpg");
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Select beach.jpg")).toBeChecked();
    });
    expect(document.querySelector('[data-file-path="album/beach.jpg"]')?.className).toMatch(
      /bg-accent\/20/,
    );
  });

  it("opens trash like a folder and can start a restore", async () => {
    stubFilesApi({
      ".luna-trash": [{
        name: "171-photo.jpg",
        original_name: "photo.jpg",
        original_path: "photo.jpg",
        kind: "file",
        size: 12,
        modified: 0,
        hidden: false,
      }],
    });
    renderFiles("/drives/d1?view=trash");
    // The regular browser renders the trash entry under its pre-trash name.
    expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
    expect(screen.queryByText("171-photo.jpg")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trash" })).toBeInTheDocument();
    // Up and the root crumb lead back to the drive, like any folder.
    expect(screen.getByRole("link", { name: "↑ Up one folder" })).toHaveAttribute("href", "/drives/d1");
    expect(screen.getByRole("link", { name: "Photos Drive" })).toHaveAttribute("href", "/drives/d1");
    // Items inside trash keep the folder row minus share/protect/rename —
    // plus Restore and Delete permanently. Upload/create stay off (nothing
    // is written INTO trash).
    expect(screen.queryByRole("button", { name: /Upload/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sharing for photo.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy photo.jpg" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move photo.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename photo.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete photo.jpg permanently" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Properties for photo.jpg" })).toBeInTheDocument();
    // Multi-select works in trash like any folder.
    expect(screen.getByLabelText("Select photo.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("Select all in this folder")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download photo.jpg" })).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=.luna-trash%2F171-photo.jpg&download=1",
    );

    // The move/copy modal names the item by its display name — the
    // `{nonce}-` storage name never reaches a title.
    fireEvent.click(screen.getByRole("button", { name: "Copy photo.jpg" }));
    const picker = await screen.findByRole("dialog", { name: "Copy photo.jpg" });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore photo.jpg" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore this?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect(await within(dialog).findByText("Request failed (500)")).toBeInTheDocument();
    expect(screen.getAllByText("Request failed (500)")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(screen.queryByText("Request failed (500)")).not.toBeInTheDocument();
    });
  });

  it("gives the drive-root Trash row folder actions", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
      __backupUnlocked: true,
    });
    renderFiles();
    expect(await screen.findByText("album")).toBeInTheDocument();
    // The Trash entry acts like a folder row: share, protect, download,
    // copy, properties — but no move/rename/delete (the trash dir itself
    // can't be moved, renamed, or trashed).
    expect(screen.getByRole("button", { name: "Sharing for Trash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protect Trash" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download Trash" })).toHaveAttribute(
      "href",
      "/api/v1/drives/d1/files/content?path=.luna-trash&download=1",
    );
    expect(screen.getByRole("button", { name: "Copy Trash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Properties for Trash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Trash" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename Trash" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Trash to trash" })).not.toBeInTheDocument();
  });

  it("shows the trash empty state through the regular browser", async () => {
    stubFilesApi({ ".luna-trash": [] });
    renderFiles("/drives/d1?path=.luna-trash");
    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();
    // Nothing to empty — the button stays disabled beside "Up one folder".
    expect(screen.getByRole("button", { name: "Empty trash" })).toBeDisabled();
  });

  it("offers Empty trash beside Up one folder with a danger modal", async () => {
    stubFilesApi({
      ".luna-trash": [{
        name: "171-photo.jpg",
        original_name: "photo.jpg",
        original_path: "photo.jpg",
        kind: "file",
        size: 12,
        modified: 0,
        hidden: false,
      }],
    });
    renderFiles("/drives/d1?path=.luna-trash");
    const emptyBtn = await screen.findByRole("button", { name: "Empty trash" });
    expect(emptyBtn).toBeEnabled();
    fireEvent.click(emptyBtn);
    const dialog = await screen.findByRole("dialog", { name: "Empty trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty trash" }));
    expect(await within(dialog).findByText("Request failed (500)")).toBeInTheDocument();
  });

  it("shows copy/move progress and cancel", async () => {
    stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
      __jobs: [{
        id: "j1",
        kind: "copy",
        state: "running",
        from_path: "photo.jpg",
        progress: 50,
        total: 100,
      }],
    });
    renderFiles();
    expect(await screen.findByText(/Copying photo.jpg/i)).toBeInTheDocument();
    expect(screen.getByText(/50% done/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("starts a copy with CSRF and plain-language network errors", async () => {
    document.cookie = "luna_csrf=copy-tok";
    const fetchMock = vi.fn(async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/drives")) {
        return new Response(JSON.stringify([{ id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz", mount_point: "/x" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/auth/me") || u.endsWith("/api/v1/auth/me")) {
        return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/setup")) {
        return new Response(JSON.stringify({ setup_completed: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/api/v1/jobs") && (init.method || "GET").toUpperCase() === "POST") {
        throw new TypeError("NetworkError when attempting to fetch resource.");
      }
      if (u.includes("/api/v1/jobs")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/api/v1/search")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/files?")) {
        return new Response(JSON.stringify([{ name: "4zjwE5no1WM.stl", kind: "file", size: 1000, modified: 0, hidden: false }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFiles();
    expect(await screen.findByText(/4zjwE5no1WM.stl/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy 4zjwE5no1WM.stl" }));
    expect(await screen.findByRole("heading", { name: /Copy 4zjwE5no1WM.stl/i })).toBeInTheDocument();
    expect(screen.getByText(/Choose a folder, or use the one you are in now/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start copying" }));
    expect((await screen.findAllByText(/Couldn't reach Luna|Couldn't start that transfer/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/NetworkError/i)).not.toBeInTheDocument();
    const postJob = fetchMock.mock.calls.find(([url, init]) =>
      String(url).includes("/api/v1/jobs") && (init?.method || "GET").toUpperCase() === "POST"
    );
    expect(postJob).toBeTruthy();
    expect(postJob[1].headers["X-CSRF-Token"]).toBe("copy-tok");
  });

  it("opens the move dialog with a folder picker", async () => {
    stubFilesApi({
      "": [{ name: "Vase (XS).gcode", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    expect(await screen.findByText(/Vase \(XS\)\.gcode/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move Vase (XS).gcode" }));
    expect(await screen.findByRole("heading", { name: "Move Vase (XS).gcode" })).toBeInTheDocument();
    expect(screen.getByText(/Choose a folder, or use the one you are in now/i)).toBeInTheDocument();
    expect(screen.queryByText(/copy it first/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Leave blank for the (top|root) of the drive/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start moving" })).toBeInTheDocument();
  });

  it("keeps delete errors inside the modal", async () => {
    stubFilesApi({
      __deleteFail: true,
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Move photo.jpg to trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => {
      expect(within(dialog).getByText(/couldn't move that to Trash/i)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/couldn't move that to Trash/i)).toHaveLength(1);
  });

  it("keeps an empty new-folder name error inside the modal", async () => {
    stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create folder" }));
    expect(await within(dialog).findByText("Choose a name.")).toBeInTheDocument();
    expect(screen.getAllByText("Choose a name.")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByText("Choose a name.")).not.toBeInTheDocument();
    });
  });

  it("creates a folder in the current folder", async () => {
    const fetchMock = stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    expect(await screen.findByRole("button", { name: /Upload/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));
    expect(await screen.findByRole("heading", { name: "New folder" })).toBeInTheDocument();
    expect(screen.getByText(/Luna will put it in the folder you are in now/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Name for this folder/i), { target: { value: "Album" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => {
      const mkdir = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/files/mkdir") && (init?.method || "GET").toUpperCase() === "POST"
      );
      expect(mkdir).toBeTruthy();
      expect(JSON.parse(mkdir[1].body)).toEqual({ path: "Album" });
    });
    expect(await screen.findByText("Album")).toBeInTheDocument();
  });

  it("creates a text file and opens it for editing", async () => {
    const fetchMock = stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Text file" }));
    expect(await screen.findByRole("heading", { name: "New text file" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("note.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => {
      const create = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes("/files/create") && (init?.method || "GET").toUpperCase() === "POST"
      );
      expect(create).toBeTruthy();
      expect(JSON.parse(create[1].body)).toEqual({ path: "note.txt" });
    });
    // The editor mounts an async text fetch — under full-suite load this
    // clears the default 1s findByRole timeout, so give it headroom.
    expect(await screen.findByRole("dialog", { name: "note.txt" }, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByLabelText("Contents of note.txt")).toBeInTheDocument();
  });

  it("lists people who already have access in the Sharing sheet", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
      __users: [
        { id: "1", role: "admin", username: "admin", display_name: "Admin" },
        { id: "2", role: "user", username: "sam", display_name: "Sam" },
        { id: "3", role: "user", username: "jo", display_name: "Jo" },
      ],
      __members: [{ id: "m1", user_id: "2", name: "Sam", caps: "view", can_manage: true, can_remove: true }],
      __links: [],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Sharing for Photos Drive" }));
    const dialog = await screen.findByRole("dialog", { name: "Sharing" });
    expect(await within(dialog).findByText(/Sam/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Access for Sam/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "New link" })).toBeInTheDocument();
  });

  it("shows a New link error in Sharing when link creation fails", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
      __users: [{ id: "1", role: "admin", username: "admin", display_name: "Admin" }],
      __members: [],
      __links: [],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Sharing for album" }));
    const sharing = await screen.findByRole("dialog", { name: "Sharing" });
    fireEvent.click(await within(sharing).findByRole("button", { name: "New link" }));
    const linkDialog = await screen.findByRole("dialog", { name: "New link" });
    fireEvent.click(within(linkDialog).getByRole("button", { name: "Create link" }));
    expect(await within(linkDialog).findByText("Luna can't find that file or folder.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Link ready" })).not.toBeInTheDocument();
  });

  it("lets a member write only in a folder they can change", async () => {
    const grants = {
      __role: "user",
      __userId: "2",
      __access: [
        { id: "m-album", kind: "path", drive_id: "d1", path: "album", caps: "view" },
        { id: "m-dcim", kind: "path", drive_id: "d1", path: "album/dcim", caps: "full" },
      ],
      album: [{ name: "dcim", kind: "dir", size: 0, modified: 0, hidden: false }],
      "album/dcim": [{ name: "shot.jpg", kind: "file", size: 12, modified: 0, hidden: false }],
    };
    stubFilesApi(grants);
    renderFiles("/drives/d1?path=album");
    expect(await screen.findByText("dcim")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move dcim" })).toBeInTheDocument();
  });

  it("shows write actions in a member write exception folder", async () => {
    stubFilesApi({
      __role: "user",
      __userId: "2",
      __access: [
        { id: "m-album", kind: "path", drive_id: "d1", path: "album", caps: "view" },
        { id: "m-dcim", kind: "path", drive_id: "d1", path: "album/dcim", caps: "full" },
      ],
      "album/dcim": [{ name: "shot.jpg", kind: "file", size: 12, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1?path=album/dcim");
    expect(await screen.findByText("shot.jpg")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Upload/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move shot.jpg" })).toBeInTheDocument();
  });

  it("offers New folder in the copy destination picker", async () => {
    stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Copy photo.jpg" }));
    const dialog = await screen.findByRole("dialog", { name: /Copy photo.jpg/i });
    expect(within(dialog).getByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "New" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "New text file" })).not.toBeInTheDocument();
  });

  it("opens a supported file directly from the file query parameter", async () => {
    stubFilesApi({
      "": [{ name: "notes.txt", kind: "file", size: 10, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1?file=notes.txt");
    expect(await screen.findByRole("dialog", { name: /notes.txt/i })).toBeInTheDocument();
  });

  it("opens a supported file inside a folder from path and file query parameters", async () => {
    stubFilesApi({
      docs: [{ name: "notes.txt", kind: "file", size: 10, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1?path=docs&file=notes.txt");
    expect(await screen.findByRole("dialog", { name: /notes.txt/i })).toBeInTheDocument();
  });

  it("opens a supported file from hashtag", async () => {
    stubFilesApi({
      "": [{ name: "notes.txt", kind: "file", size: 10, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1#notes.txt");
    expect(await screen.findByRole("dialog", { name: /notes.txt/i })).toBeInTheDocument();
  });

  it("ignores unsupported file in query parameter and does not open viewer", async () => {
    stubFilesApi({
      "": [{ name: "data.bin", kind: "file", size: 50, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1?file=data.bin");
    expect(await screen.findByText("data.bin")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores unsupported file in hashtag and does not open viewer", async () => {
    stubFilesApi({
      "": [{ name: "data.bin", kind: "file", size: 50, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1#data.bin");
    expect(await screen.findByText("data.bin")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clears file parameter when the viewer is closed", async () => {
    stubFilesApi({
      "": [{ name: "notes.txt", kind: "file", size: 10, modified: 0, hidden: false }],
    });
    renderFiles("/drives/d1?file=notes.txt");
    const dialog = await screen.findByRole("dialog", { name: /notes.txt/i });
    expect(dialog).toBeInTheDocument();
    const closeBtn = within(dialog).getByRole("button", { name: "Close editor" });
    fireEvent.click(closeBtn);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});

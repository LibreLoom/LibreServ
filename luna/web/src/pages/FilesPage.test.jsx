import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext";
import FilesPage from "./FilesPage";

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
      return new Response(JSON.stringify([{ id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz", mount_point: "/x" }]), { status: 200, headers: { "Content-Type": "application/json" } });
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
    if (u.includes("/files?")) {
      const listing = byPath[filesPath(u)] ?? [];
      return new Response(JSON.stringify(listing), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/users")) {
      return new Response(JSON.stringify(byPath.__users || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/grants")) {
      return new Response(JSON.stringify(byPath.__grants || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.endsWith("/shares") && method === "POST") {
      if (byPath.__postShare) return byPath.__postShare(String(init.body || ""));
      return new Response(JSON.stringify({ error: "Luna can't find that file or folder." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/shares")) {
      return new Response(JSON.stringify(byPath.__shares || []), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderFiles(path = "/drives/d1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes><Route path="/drives/:id" element={<FilesPage />} /></Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
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
    expect(screen.getByText("Current folder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sharing for photo.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Protect photo.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protect Photos Drive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Share this folder/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Open as a folder on a computer/i })).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Photos Drive" })).toHaveAttribute("href", "/drives/d1");
    expect(screen.getByRole("link", { name: "album" })).toHaveAttribute("href", "/drives/d1?path=album");

    fireEvent.click(screen.getByRole("link", { name: "vacation" }));
    expect(await screen.findByText("beach.jpg")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "↑ Up one folder" })).toHaveAttribute(
      "href",
      "/drives/d1?path=album",
    );
  });

  it("opens trash and can start a restore", async () => {
    stubFilesApi({
      "": [],
      __trash: [{
        name: "171-photo.jpg",
        original_name: "photo.jpg",
        kind: "file",
        size: 12,
        path: ".luna-trash/171-photo.jpg",
      }],
    });
    renderFiles("/drives/d1?view=trash");
    expect(await screen.findByText("photo.jpg")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to files" })).toHaveAttribute("href", "/drives/d1");
    fireEvent.click(screen.getByRole("button", { name: "Put photo.jpg back" }));
    const dialog = await screen.findByRole("dialog", { name: "Put this back?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Put it back" }));
    expect(await within(dialog).findByText("Request failed (500)")).toBeInTheDocument();
    expect(screen.getAllByText("Request failed (500)")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    await waitFor(() => {
      expect(screen.queryByText("Request failed (500)")).not.toBeInTheDocument();
    });
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
    expect(await screen.findByRole("heading", { name: "Edit note.txt" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Contents of note.txt")).toBeInTheDocument();
  });

  it("lists people who already have access in the Sharing sheet", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
      __users: [
        { id: "1", role: "admin", username: "admin", display_name: "Admin" },
        { id: "2", role: "user", username: "sam", display_name: "Sam" },
      ],
      __grants: [{ id: "g1", user_id: "2", drive_id: "d1", path: "album", permission: "read" }],
      __shares: [],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Sharing for Photos Drive" }));
    const dialog = await screen.findByRole("dialog", { name: "Sharing" });
    expect(await within(dialog).findByText(/Sam/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Access for Sam/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Grant access" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "New link" })).toBeInTheDocument();
  });

  it("shows a New link error in Sharing when link creation fails", async () => {
    stubFilesApi({
      "": [{ name: "album", kind: "dir", size: 0, modified: 0, hidden: false }],
      __users: [{ id: "1", role: "admin", username: "admin", display_name: "Admin" }],
      __grants: [],
      __shares: [],
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "Sharing for album" }));
    const sharing = await screen.findByRole("dialog", { name: "Sharing" });
    fireEvent.click(within(sharing).getByRole("button", { name: "New link" }));
    const linkDialog = await screen.findByRole("dialog", { name: "New link" });
    fireEvent.click(within(linkDialog).getByRole("button", { name: "Create link" }));
    expect(await within(linkDialog).findByText("Luna can't find that file or folder.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Link ready" })).not.toBeInTheDocument();
  });

  it("lets a member write only in a folder they can change", async () => {
    const grants = {
      __role: "user",
      __userId: "2",
      __grants: [
        { id: "g-album", user_id: "2", drive_id: "d1", path: "album", permission: "read" },
        { id: "g-dcim", user_id: "2", drive_id: "d1", path: "album/dcim", permission: "write" },
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
      __grants: [
        { id: "g-album", user_id: "2", drive_id: "d1", path: "album", permission: "read" },
        { id: "g-dcim", user_id: "2", drive_id: "d1", path: "album/dcim", permission: "write" },
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
});

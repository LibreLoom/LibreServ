import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import FilesPage from "./FilesPage";

function filesPath(url) {
  try {
    return new URL(String(url), "http://luna.test").searchParams.get("path") || "";
  } catch {
    return "";
  }
}

function stubFilesApi(byPath) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/drives")) {
      return new Response(JSON.stringify([{ id: "d1", label: "Photos Drive", state: "as_is", fs_type: "ext4", device: "sdz", mount_point: "/x" }]), { status: 200, headers: { "Content-Type": "application/json" } });
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
    if (u.includes("/files?")) {
      const listing = byPath[filesPath(u)] ?? [];
      return new Response(JSON.stringify(listing), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  }));
}

function renderFiles(path = "/drives/d1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/drives/:id" element={<FilesPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("FilesPage", () => {
  it("shows the drop zone and empty folder", async () => {
    stubFilesApi({
      "": [{ name: "photo.jpg", kind: "file", size: 1000, modified: 0, hidden: false }],
    });
    renderFiles();
    expect(screen.getAllByText(/Drop files here/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Choose files/i })).toBeInTheDocument();
    expect(await screen.findByText(/photo.jpg/i)).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Put this back?" })).toBeInTheDocument();
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
});


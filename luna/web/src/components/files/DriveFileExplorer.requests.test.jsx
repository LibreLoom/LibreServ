import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { AuthProvider } from "../../context/AuthContext";
import { FileOpsProvider } from "../../context/FileOpsContext.jsx";
import DriveFileExplorer from "./DriveFileExplorer.jsx";
import FileOpsDock from "./fileOps/FileOpsDock.jsx";
import { driveSource, fileListKey } from "../../lib/fileSource.jsx";
import { TRASH_PATH } from "../../lib/paths.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const FILES = [
  { name: "a.txt", kind: "file", size: 1, hidden: false },
  { name: "b.txt", kind: "file", size: 1, hidden: false },
  { name: "c.txt", kind: "file", size: 1, hidden: false },
];

const TRASHED = ["a", "b", "c"].map((n) => ({
  name: `17${n}-${n}.txt`,
  original_name: `${n}.txt`,
  original_path: `${n}.txt`,
  kind: "file",
  size: 1,
  hidden: false,
}));

/**
 * @param {{ path?: string, listing: any[], failing?: string, failWith?: string, driveState?: string, drives?: any[] }} opts
 *   `failing`: a file name whose request fails with `failWith`.
 */
function renderExplorer({ path, listing, failing = "", failWith = "Luna is busy.", driveState = "mounted", drives = null }) {
  const availableDrives = drives || [{ id: "d1", label: "Photos", state: driveState }];
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push([method, u, body]);
    if (u.endsWith("/api/v1/auth/me")) return json({ id: "u1", username: "max", role: "admin" });
    if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
    if (u.endsWith("/api/v1/setup")) return json({ setup_completed: true });
    if (u.endsWith("/api/v1/drives")) return json(availableDrives);
    if (u.endsWith("/api/v1/connect/status")) return json({ connect_active: true });
    if (method === "DELETE" && u.includes("/files?path=")) {
      return decodeURIComponent(u).includes(failing) && failing ? json({ error: failWith }, 500) : json({ ok: true });
    }
    if (method === "POST" && u.includes("/files/purge")) {
      const which = String(body?.path || "");
      return failing && which.includes(failing) ? json({ error: failWith }, 500) : json({ ok: true });
    }
    if (u.includes("/api/v1/drives/d1/files?path=")) return json(listing);
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider>
      <ToastProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <FileOpsProvider>
              <AuthProvider>
                <DriveFileExplorer driveId="d1" driveLabel="Photos" isAdmin path={path} />
                <FileOpsDock />
              </AuthProvider>
            </FileOpsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return { calls, client };
}

describe("DriveFileExplorer long requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains a read-only drive and hides actions that would change it", async () => {
    renderExplorer({ listing: FILES, driveState: "readonly" });

    await screen.findByText("a.txt");
    expect(screen.getByRole("status")).toHaveTextContent(
      "This drive is read-only. You can open and download files, but you can't change them.",
    );
    expect(screen.queryByRole("button", { name: "New" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename a.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to trash a.txt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy a.txt" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download a.txt" })).toBeInTheDocument();
  });

  it("starts a copy from a read-only folder at the writable drive root", async () => {
    const { calls } = renderExplorer({
      path: "Nested",
      listing: FILES,
      drives: [
        { id: "d1", label: "Photos", state: "readonly" },
        { id: "d2", label: "Documents", state: "mounted" },
      ],
    });

    await screen.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Copy a.txt" }));

    await waitFor(() => {
      expect(calls.some(([method, url]) => method === "GET" && url.includes("/drives/d2/files?path="))).toBe(true);
    });
    const destinationList = calls.find(([method, url]) => method === "GET" && url.includes("/drives/d2/files?path="));
    expect(destinationList[1]).toMatch(/path=$/);
  });

  it("trashes a selection in the file task card and carries on past one failure", async () => {
    const { calls } = renderExplorer({ listing: FILES, failing: "b.txt" });
    // The rows must be there before selecting, or the select-all ticks an
    // empty folder and the toolbar never appears.
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByLabelText("Select all in this folder"));
    fireEvent.click(await screen.findByRole("button", { name: "Trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    // The dialog hands the work over and closes; the failure lives in its row.
    const dock = await screen.findByRole("region", { name: "File tasks" });
    // The card starts collapsed; open it for the assertions below.
    fireEvent.click(await within(dock).findByRole("button", { name: "Show details" }));
    expect(await within(dock).findByText("Luna is busy.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const deletes = calls.filter(([method]) => method === "DELETE");
    expect(deletes).toHaveLength(3);
    expect(within(dock).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("deletes permanently through the card, showing one problem out of three", async () => {
    const { calls } = renderExplorer({ path: ".luna-trash", listing: TRASHED, failing: "17c-c.txt" });
    // The rows must be there before selecting, or the select-all ticks an
    // empty folder and the toolbar never appears.
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByLabelText("Select all in this folder"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete permanently?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    const dock = await screen.findByRole("region", { name: "File tasks" });
    // The card starts collapsed; open it for the assertions below.
    fireEvent.click(await within(dock).findByRole("button", { name: "Show details" }));
    expect(await within(dock).findByText("Luna is busy.")).toBeInTheDocument();
    expect(within(dock).getByText("Deleted 2 of 3 items permanently")).toBeInTheDocument();
    expect(calls.filter(([method, url]) => method === "POST" && url.includes("/files/purge"))).toHaveLength(3);
    // The dialog carries no error of its own any more.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("empties the trash through the card and keeps a failure in its row", async () => {
    const { calls } = renderExplorer({
      path: ".luna-trash",
      listing: TRASHED,
      failing: ".luna-trash",
      failWith: "Luna couldn't reach the drive.",
    });
    // The button is disabled until the trash listing arrives — click it only
    // once Luna has counted what's inside.
    const emptyBtn = await screen.findByRole("button", { name: "Empty trash" });
    await waitFor(() => expect(emptyBtn).toBeEnabled());
    fireEvent.click(emptyBtn);
    const dialog = await screen.findByRole("dialog", { name: "Empty trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty trash" }));

    const dock = await screen.findByRole("region", { name: "File tasks" });
    // The card starts collapsed; open it for the assertions below.
    fireEvent.click(await within(dock).findByRole("button", { name: "Show details" }));
    expect(await within(dock).findByText("Luna couldn't reach the drive.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const purge = calls.find(([method, url]) => method === "POST" && url.includes("/files/purge"));
    expect(purge[2]).toEqual({ path: ".luna-trash" });
  });

  // The phone sheet's destructive row used to keep the danger card's extra
  // padding, so "Move to trash" stood half again as tall as every action above
  // it. Every row in the sheet is one size now.
  it("gives every action in a phone row sheet the same height", async () => {
    vi.stubGlobal("matchMedia", (query) => /** @type {any} */ ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderExplorer({ listing: FILES });
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByRole("button", { name: "Actions for a.txt" }));
    const dialog = await screen.findByRole("dialog", { name: "a.txt" });
    const rows = [...dialog.querySelectorAll('[data-slot="card-button"]')];
    expect(rows.length).toBeGreaterThan(1);
    const sizes = rows.map((row) => row.className.split(/\s+/).filter((c) => /^(p|py|px|h)-/.test(c)).sort());
    for (const size of sizes) expect(size).toEqual(sizes[0]);
  });

  it("refreshes the Trash listing when a folder is trashed", async () => {
    // Deleting `Documents` changes the drive root and `Documents` — never the
    // trash dir, which is its own listing. Without an explicit invalidate the
    // trash query keeps its cached rows for the whole staleTime, so a folder
    // that really did land in the trash looks permanently gone: the reported
    // "deleting a folder when an item inside it was trashed silently deletes
    // it". The trash key must be among the ones a delete makes stale.
    const { calls, client } = renderExplorer({ listing: FILES });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    // The rows must be there before selecting, or the select-all ticks an
    // empty folder and the toolbar never appears.
    await screen.findByText("a.txt");
    fireEvent.click(screen.getByLabelText("Select all in this folder"));
    fireEvent.click(await screen.findByRole("button", { name: "Trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    await waitFor(() => expect(calls.some(([method]) => method === "DELETE")).toBe(true));
    const trashKey = fileListKey(driveSource, "d1", TRASH_PATH);
    await waitFor(() => {
      expect(invalidate.mock.calls.map(([arg]) => arg.queryKey)).toContainEqual(trashKey);
    });
    // And it is the same key the trash view itself reads, so the refresh lands.
    expect(trashKey).toEqual(["files", "d1", ".luna-trash"]);
  });
});

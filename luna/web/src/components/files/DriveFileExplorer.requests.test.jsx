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
 * @param {{ path?: string, listing: any[], failing?: string, failWith?: string }} opts
 *   `failing`: a file name whose request fails with `failWith`.
 */
function renderExplorer({ path, listing, failing = "", failWith = "Luna is busy." }) {
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
    if (u.endsWith("/api/v1/drives")) return json([{ id: "d1", label: "Photos", state: "mounted" }]);
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
  return calls;
}

describe("DriveFileExplorer long requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("trashes a selection in the file task card and carries on past one failure", async () => {
    const calls = renderExplorer({ listing: FILES, failing: "b.txt" });
    fireEvent.click(await screen.findByLabelText("Select all in this folder"));
    fireEvent.click(await screen.findByRole("button", { name: "Trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to trash" }));

    // The dialog hands the work over and closes; the failure lives in its row.
    const dock = await screen.findByRole("region", { name: "File tasks" });
    expect(await within(dock).findByText("Luna is busy.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const deletes = calls.filter(([method]) => method === "DELETE");
    expect(deletes).toHaveLength(3);
    expect(within(dock).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("deletes permanently through the card, showing one problem out of three", async () => {
    const calls = renderExplorer({ path: ".luna-trash", listing: TRASHED, failing: "17c-c.txt" });
    fireEvent.click(await screen.findByLabelText("Select all in this folder"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete permanently?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    const dock = await screen.findByRole("region", { name: "File tasks" });
    expect(await within(dock).findByText("Luna is busy.")).toBeInTheDocument();
    expect(within(dock).getByText("Deleted 2 of 3 items permanently")).toBeInTheDocument();
    expect(calls.filter(([method, url]) => method === "POST" && url.includes("/files/purge"))).toHaveLength(3);
    // The dialog carries no error of its own any more.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("empties the trash through the card and keeps a failure in its row", async () => {
    const calls = renderExplorer({
      path: ".luna-trash",
      listing: TRASHED,
      failing: ".luna-trash",
      failWith: "Luna couldn't reach the drive.",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty trash" }));

    const dock = await screen.findByRole("region", { name: "File tasks" });
    expect(await within(dock).findByText("Luna couldn't reach the drive.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const purge = calls.find(([method, url]) => method === "POST" && url.includes("/files/purge"));
    expect(purge[2]).toEqual({ path: ".luna-trash" });
  });
});

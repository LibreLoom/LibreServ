import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import { AuthProvider } from "../../context/AuthContext";
import { FileOpsProvider } from "../../context/FileOpsContext.jsx";
import DriveFileExplorer from "./DriveFileExplorer.jsx";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const FILES = [
  { name: "notes.txt", kind: "file", size: 38, hidden: false },
  { name: "readme.md", kind: "file", size: 102, hidden: false },
];

/**
 * Renders the explorer with the Toaster, so a mutation's toast is real DOM —
 * the whole point of these tests is what a person would actually see.
 */
function renderExplorer() {
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
    if (u.includes("/files/rename")) return json({ ok: true });
    if (u.includes("/api/v1/drives/d1/files?path=")) return json(FILES);
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
                <DriveFileExplorer driveId="d1" driveLabel="Photos" isAdmin path="Documents" />
                <Toaster />
              </AuthProvider>
            </FileOpsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return calls;
}

/** Open the row's rename dialog and submit `newName`. */
async function renameTo(newName) {
  fireEvent.click(await screen.findByRole("button", { name: "Rename notes.txt" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename notes.txt" });
  fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: newName } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
}

/**
 * The toast itself. Scoped to the toaster region because the file list and
 * search also expose `role="status"` live regions, so a bare role query would
 * be ambiguous.
 */
async function findToast() {
  const toaster = await screen.findByRole("region", { name: "Notifications" });
  return within(toaster).findByRole("status");
}

describe("DriveFileExplorer rename", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the Renamed. toast after a rename lands", async () => {
    const calls = renderExplorer();
    await renameTo("list.txt");

    const toast = await findToast();
    expect(toast).toHaveTextContent("Renamed.");
    expect(calls.some(([method, url]) => method === "POST" && url.includes("/files/rename"))).toBe(true);
  });

  it("releases the toast's entrance animation so a stalled timeline can't hide it", async () => {
    // The toast's visible state is owned by its entrance keyframes, whose 0%
    // frame is `opacity: 0` with fill-mode `both`. While that class is applied,
    // an animation timeline that never advances (a throttled or occluded tab,
    // a starved phone compositor) leaves the toast mounted, correctly stacked,
    // and completely transparent — the reported "toast is not visible". The
    // class must therefore be dropped once the entrance has had its run.
    renderExplorer();
    await renameTo("list.txt");

    const toast = await findToast();
    expect(toast).toHaveTextContent("Renamed.");

    await waitFor(
      () => expect(toast).not.toHaveClass("animate-toast-enter"),
      { timeout: 2000 },
    );
    // Still on screen and readable once the animation is done with it.
    expect(toast).toBeInTheDocument();
    expect(toast).toHaveTextContent("Renamed.");
  });
});

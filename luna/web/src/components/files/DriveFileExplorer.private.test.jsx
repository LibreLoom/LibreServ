import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@libreloom/ui/context/ThemeContext.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { AuthProvider } from "../../context/AuthContext";
import DriveFileExplorer from "./DriveFileExplorer.jsx";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function renderExplorer({ listing = [], mine = [], initialEntries = ["/"], path, backups = [] } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = init.method || "GET";
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push([method, u, body]);
    if (u.endsWith("/api/v1/auth/me")) {
      return json({ id: "u1", username: "max", role: "admin" });
    }
    if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
    if (u.endsWith("/api/v1/setup")) return json({ setup_completed: true });
    if (u.endsWith("/api/v1/drives")) return json([{ id: "d1", label: "Photos", state: "mounted" }]);
    if (u.endsWith("/api/v1/connect/status")) return json({ connect_active: true });
    if (u.endsWith("/api/v1/private-backups/mine")) return json({ items: mine });
    if (u.includes("/files/mkdir") || u.includes("/files/create") || u.includes("/files/upload")) {
      return json({ ok: true });
    }
    if (u.endsWith("/api/v1/drives/d1/backups")) return json(backups);
    if (u.includes("/api/v1/drives/d1/files?path=")) return json(listing);
    return json([]);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider>
    <ToastProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={initialEntries}>
          <AuthProvider>
            <DriveFileExplorer driveId="d1" driveLabel="Photos" isAdmin path={path} />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ToastProvider>
    </ThemeProvider>,
  );
  return calls;
}

async function openNewMenu() {
  fireEvent.click(await screen.findByRole("button", { name: "New" }));
  return screen.findByRole("menu", { name: "New" });
}

describe("DriveFileExplorer private folders", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists Private folder right after Folder in the New menu — folders only", async () => {
    renderExplorer();
    const menu = await openNewMenu();
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Private folder" })).toBeInTheDocument());
    const items = within(menu).getAllByRole("menuitem").map((el) => el.textContent);
    expect(items.indexOf("Private folder")).toBe(items.indexOf("Folder") + 1);
    expect(within(menu).queryByRole("menuitem", { name: "Private file" })).not.toBeInTheDocument();
  });

  it("creates a private folder with private: true", async () => {
    const calls = renderExplorer();
    const menu = await openNewMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Private folder" }));
    const field = await screen.findByLabelText("Name for this private folder");
    fireEvent.change(field, { target: { value: "Taxes" } });
    // The one-line reality check sits on the surface; the rest is a tap away.
    expect(
      screen.getByText(/private folder is only visible to you and the people you share it with/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create private folder" }));
    await waitFor(() => {
      expect(calls.find(([m, u]) => m === "POST" && u.endsWith("/files/mkdir"))?.[2])
        .toEqual({ path: "Taxes", private: true });
    });
  });

  it("shows Not backed up on my private folder that has no backups", async () => {
    renderExplorer({
      listing: [{ name: "Taxes", kind: "dir", size: 0, hidden: false }],
      mine: [{ drive_id: "d1", path: "Taxes", name: "Taxes", drive_backups: 0, cloud_backup: false }],
    });
    const button = await screen.findByRole("button", { name: "Back up Taxes" });
    expect(await within(button).findByText("Not backed up")).toBeInTheDocument();
  });

  it("does not show Not backed up once the private folder has a drive backup", async () => {
    const calls = renderExplorer({
      listing: [{ name: "Taxes", kind: "dir", size: 0, hidden: false }],
      mine: [{ drive_id: "d1", path: "Taxes", name: "Taxes", drive_backups: 1, cloud_backup: false }],
    });
    await screen.findByRole("button", { name: "Back up Taxes" });
    await waitFor(() => expect(calls.some(([, u]) => u.endsWith("/private-backups/mine"))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Not backed up")).not.toBeInTheDocument();
  });

  it("browses the Backups folder like Trash: each backup is a folder row", async () => {
    renderExplorer({
      path: ".luna-backups",
      backups: [{ id: "b1", source_name: "Trips", source_drive_name: "Photo drive", source_path: "Trips", status: "active", last_ok_at: 1, size_bytes: 10 }],
    });
    expect(await screen.findByText("Trips")).toBeInTheDocument();
  });

  it("offers a Backups row at the drive root when this drive holds backups", async () => {
    renderExplorer({
      backups: [{ id: "b1", source_name: "Trips", source_drive_name: "Photo drive", source_path: "Trips", status: "active", last_ok_at: 1, size_bytes: 10 }],
    });
    expect(await screen.findByText("Backups")).toBeInTheDocument();
  });
});

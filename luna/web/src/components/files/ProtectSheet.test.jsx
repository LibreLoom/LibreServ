import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import ProtectSheet from "./ProtectSheet";

/**
 * @param {{
 *   drives?: any[],
 *   protections?: any[],
 *   backupUnlocked?: boolean,
 *   backupSources?: any[],
 *   onBackupSources?: (sources: any[]) => void,
 * }} [opts]
 */
function stubProtectApi({
  drives = [],
  protections = [],
  backupUnlocked = false,
  backupSources = [],
  onBackupSources,
} = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = typeof url === "string" ? url : (url?.url || String(url));
    const method = (init.method || "GET").toUpperCase();
    if (u.includes("/auth/me") || u.includes("/api/v1/auth/me")) {
      return new Response(JSON.stringify({ id: "1", role: "admin", username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/setup")) {
      return new Response(JSON.stringify({ setup_completed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes("/api/v1/drives") && !u.includes("/detected") && !u.includes("/files") && !u.includes("/health")) {
      return new Response(JSON.stringify(drives), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/protections")) {
      return new Response(JSON.stringify(protections), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/connect/backup-sources") && method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      onBackupSources?.(body.sources);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v1/connect/status")) {
      return new Response(JSON.stringify({
        backup_unlocked: backupUnlocked,
        backup_sources: backupSources,
        connect_active: backupUnlocked,
        enabled: backupUnlocked,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 500 });
  }));
}

function renderSheet(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <ProtectSheet driveId="d1" path="photos" onClose={() => {}} {...props} />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("ProtectSheet", () => {
  it("lets an admin protect a folder onto another drive", async () => {
    stubProtectApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/d1" },
        { id: "d2", label: "Backup", mount_point: "/mnt/d2" },
      ],
      protections: [],
    });
    renderSheet();
    expect(await screen.findByRole("heading", { name: /Protect/ })).toBeInTheDocument();
    expect(screen.getByText(/spare copy on another drive/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Protect" })).toBeInTheDocument();
    const copyOnto = screen.getByRole("button", { name: "Copy onto" });
    expect(copyOnto.className).toMatch(/bg-primary/);
    expect(copyOnto.className).toMatch(/text-secondary/);
    expect(screen.queryByRole("button", { name: "New link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
  });

  it("explains when a second drive and cloud backup are both missing", async () => {
    stubProtectApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/d1" }],
      protections: [],
      backupUnlocked: false,
    });
    renderSheet();
    expect(await screen.findByText(/Needs a second drive, or cloud backup connected/i)).toBeInTheDocument();
  });

  it("offers cloud backup when unlocked with only one drive", async () => {
    const posted = [];
    stubProtectApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/d1" }],
      protections: [],
      backupUnlocked: true,
      backupSources: [],
      onBackupSources: (sources) => posted.push(sources),
    });
    renderSheet();
    expect(await screen.findByRole("heading", { name: "Cloud backup" })).toBeInTheDocument();
    expect(screen.queryByText(/Needs a second drive/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy to cloud" }));
    await waitFor(() => {
      expect(posted[posted.length - 1]).toEqual([{ kind: "folder", path: "/mnt/d1/photos" }]);
    });
  });
});

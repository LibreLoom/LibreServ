import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import ProtectSheet, {
  buildCloudSource,
  cloudFolderPath,
  matchesCloudSource,
} from "./ProtectSheet";

function stubProtectApi({
  drives = [],
  protections = [],
  connect = { backup_unlocked: false, backup_sources: [] },
  onBackupSources,
} = /** @type {{
  drives?: any[],
  protections?: any[],
  connect?: { backup_unlocked: boolean, backup_sources: any[] },
  onBackupSources?: (sources: unknown) => void,
}} */ ({})) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = typeof url === "string" ? url : url?.url || String(url);
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
      if (u.includes("/api/v1/connect/status")) {
        return new Response(JSON.stringify(connect), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.includes("/api/v1/connect/backup-sources") && init?.method === "POST") {
        const body = JSON.parse(init.body || "{}");
        onBackupSources?.(body.sources);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 500 });
    }),
  );
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

describe("cloud source helpers", () => {
  it("joins mount and relative folder paths", () => {
    expect(cloudFolderPath("/mnt/drive/", "photos/album")).toBe("/mnt/drive/photos/album");
    expect(cloudFolderPath("/mnt/drive", "")).toBe("/mnt/drive");
  });

  it("matches drive and folder sources", () => {
    expect(
      matchesCloudSource([{ kind: "drive", drive_id: "d1" }], { driveId: "d1", objectPath: "", mountPoint: "/m" }),
    ).toBe(true);
    expect(
      matchesCloudSource([{ kind: "folder", path: "/m/photos" }], {
        driveId: "d1",
        objectPath: "photos",
        mountPoint: "/m",
      }),
    ).toBe(true);
    expect(buildCloudSource({ driveId: "d1", objectPath: "", mountPoint: "/m" })).toEqual({
      kind: "drive",
      drive_id: "d1",
    });
  });
});

describe("ProtectSheet", () => {
  it("lets an admin protect a folder onto another drive", async () => {
    stubProtectApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      protections: [],
    });
    renderSheet();
    expect(await screen.findByRole("heading", { name: /Protect/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /On other drives/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Protect" })).toBeInTheDocument();
    const copyOnto = screen.getByRole("button", { name: "Copy onto" });
    // Dropdown sits on the inverted option panel (bg-primary), so it uses the card surface.
    expect(copyOnto.className).toMatch(/bg-secondary/);
    expect(copyOnto.className).toMatch(/text-primary/);
    expect(screen.queryByRole("button", { name: "New link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();
  });

  it("explains when a second drive is missing but still shows cloud", async () => {
    stubProtectApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      protections: [],
      connect: { backup_unlocked: false, backup_sources: [] },
    });
    renderSheet();
    expect(await screen.findByText(/Needs another drive/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /In the cloud/i })).toBeInTheDocument();
    expect(screen.getByText(/Add a card at connect\.luna\.libreloom\.org/i)).toBeInTheDocument();
  });

  it("lets an admin add copies onto more than one other drive", async () => {
    stubProtectApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
        { id: "d3", label: "Archive", mount_point: "/mnt/archive" },
      ],
      protections: [
        {
          id: "p1",
          source_drive: "d1",
          source_path: "photos",
          target_drive: "d2",
          last_run: 1_700_000_000,
        },
      ],
      connect: { backup_unlocked: false, backup_sources: [] },
    });
    renderSheet();
    expect(await screen.findByText(/Copy on Backup/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add another copy" })).toBeInTheDocument();
    const copyOnto = screen.getByRole("button", { name: "Copy onto" });
    expect(copyOnto).toBeInTheDocument();
    // Already used Backup must not appear as an option.
    await userEvent.click(copyOnto);
    expect(screen.queryByRole("option", { name: "Backup" })).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Archive" })).toBeInTheDocument();
  });

  it("hides the add form when every other drive already has a copy", async () => {
    stubProtectApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      protections: [
        {
          id: "p1",
          source_drive: "d1",
          source_path: "photos",
          target_drive: "d2",
          last_run: 0,
        },
      ],
    });
    renderSheet();
    expect(await screen.findByText(/Copy on Backup/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add another copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy onto" })).not.toBeInTheDocument();
  });

  it("lets an admin start cloud backup when unlocked", async () => {
    const user = userEvent.setup();
    /** @type {unknown} */
    let saved = null;
    stubProtectApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      protections: [],
      connect: { backup_unlocked: true, backup_sources: [] },
      onBackupSources: (sources) => {
        saved = sources;
      },
    });
    renderSheet();
    const btn = await screen.findByRole("button", { name: "Copy to cloud" });
    await user.click(btn);
    expect(saved).toEqual([{ kind: "folder", path: "/mnt/main/photos" }]);
  });

  it("lets an admin stop cloud backup for a drive", async () => {
    const user = userEvent.setup();
    /** @type {unknown} */
    let saved = null;
    stubProtectApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Other", mount_point: "/mnt/other" },
      ],
      protections: [],
      connect: {
        backup_unlocked: true,
        backup_sources: [
          { kind: "drive", drive_id: "d1" },
          { kind: "drive", drive_id: "d2" },
        ],
      },
      onBackupSources: (sources) => {
        saved = sources;
      },
    });
    renderSheet({ path: "" });
    const btn = await screen.findByRole("button", { name: "Stop cloud backup" });
    await user.click(btn);
    expect(saved).toEqual([{ kind: "drive", drive_id: "d2" }]);
  });

  it("keeps button in loading and disabled state while enabling cloud backup until status refetches", async () => {
    const user = userEvent.setup();
    /** @type {((value?: unknown) => void) | undefined} */
    let resolveBackupSources;
    const backupSourcesPromise = new Promise((resolve) => {
      resolveBackupSources = resolve;
    });

    const connectStatus = { backup_unlocked: true, backup_sources: [] };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = typeof url === "string" ? url : url?.url || String(url);
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
        if (u.includes("/api/v1/drives")) {
          return new Response(JSON.stringify([{ id: "d1", label: "Main", mount_point: "/mnt/main" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/api/v1/protections")) {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/api/v1/connect/status")) {
          return new Response(JSON.stringify(connectStatus), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/api/v1/connect/backup-sources") && init?.method === "POST") {
          await backupSourcesPromise;
          const body = JSON.parse(init.body || "{}");
          connectStatus.backup_sources = body.sources;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      }),
    );

    renderSheet();
    const btn = await screen.findByRole("button", { name: "Copy to cloud" });
    expect(btn).not.toBeDisabled();

    await user.click(btn);

    // While in-flight, the button is loading and disabled
    expect(btn).toBeDisabled();
    expect(screen.getByRole("button", { name: /Copy to cloud/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Copy to cloud/i })).toHaveAttribute("aria-busy", "true");

    // Complete the POST and refetch
    resolveBackupSources?.();

    // Now the button transitions to "Stop cloud backup" and is enabled
    const stopBtn = await screen.findByRole("button", { name: "Stop cloud backup" });
    expect(stopBtn).toBeInTheDocument();
    expect(stopBtn).not.toBeDisabled();
    expect(stopBtn).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("On")).toBeInTheDocument();
  });

  it("keeps button in loading and disabled state while stopping cloud backup until status refetches", async () => {
    const user = userEvent.setup();
    /** @type {((value?: unknown) => void) | undefined} */
    let resolveBackupSources;
    const backupSourcesPromise = new Promise((resolve) => {
      resolveBackupSources = resolve;
    });

    const connectStatus = {
      backup_unlocked: true,
      backup_sources: [{ kind: "folder", path: "/mnt/main/photos" }],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = typeof url === "string" ? url : url?.url || String(url);
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
        if (u.includes("/api/v1/drives")) {
          return new Response(JSON.stringify([{ id: "d1", label: "Main", mount_point: "/mnt/main" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/api/v1/protections")) {
          return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.includes("/api/v1/connect/status")) {
          return new Response(JSON.stringify(connectStatus), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (u.includes("/api/v1/connect/backup-sources") && init?.method === "POST") {
          await backupSourcesPromise;
          const body = JSON.parse(init.body || "{}");
          connectStatus.backup_sources = body.sources;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      }),
    );

    renderSheet();
    const btn = await screen.findByRole("button", { name: "Stop cloud backup" });
    expect(btn).not.toBeDisabled();

    await user.click(btn);

    // While in-flight, the button is loading and disabled
    expect(btn).toBeDisabled();
    expect(screen.getByRole("button", { name: /Stop cloud backup/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Stop cloud backup/i })).toHaveAttribute("aria-busy", "true");

    // Complete the POST and refetch
    resolveBackupSources?.();

    // Now the button transitions to "Copy to cloud" and is enabled
    const copyBtn = await screen.findByRole("button", { name: "Copy to cloud" });
    expect(copyBtn).toBeInTheDocument();
    expect(copyBtn).not.toBeDisabled();
    expect(copyBtn).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText("On")).not.toBeInTheDocument();
  });
});

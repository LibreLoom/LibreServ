import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import ProtectSheet, {
  buildCloudSource,
  cloudFolderPath,
  matchesCloudSource,
} from "./ProtectSheet";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function backup(overrides = {}) {
  return {
    source_drive: "d1",
    source_drive_name: "Main",
    source_path: "photos",
    source_name: "photos",
    kind: "drive",
    state: "ok",
    status: "active",
    stop_reason: "",
    last_error: "",
    hard: false,
    first_done: true,
    created_by: "admin",
    can_delete: true,
    ...overrides,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubBackupApi({
  drives = [],
  backups = [],
  connect = { backup_unlocked: false, backup_sources: [] },
  onBackupSources,
  onCreate,
  onRun,
  onDelete,
  runReply = { status: 200, body: { done: true } },
  deleteReply = { status: 200, body: {} },
} = /** @type {{
  drives?: any[],
  backups?: any[],
  connect?: { backup_unlocked: boolean, backup_sources: any[], backup_status?: any },
  onBackupSources?: (sources: unknown) => void,
  onCreate?: (body: any) => void,
  onRun?: (body: any) => void,
  onDelete?: (url: string) => void,
  runReply?: { status: number, body: any },
  deleteReply?: { status: number, body: any },
}} */ ({})) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = typeof url === "string" ? url : url?.url || String(url);
      const method = init?.method || "GET";
      if (u.includes("/auth/me") || u.includes("/api/v1/auth/me")) {
        return json({ id: "1", role: "admin", username: "admin" });
      }
      if (u.includes("/setup")) {
        return json({ setup_completed: true });
      }
      if (u.includes("/api/v1/drives") && !u.includes("/detected") && !u.includes("/files") && !u.includes("/health")) {
        return json(drives);
      }
      if (u.includes("/api/v1/backups/") && u.endsWith("/run")) {
        onRun?.(JSON.parse(init?.body || "{}"));
        return json(runReply.body, runReply.status);
      }
      if (u.includes("/api/v1/backups/") && method === "DELETE") {
        onDelete?.(u);
        return json(deleteReply.body, deleteReply.status);
      }
      if (u.includes("/api/v1/backups") && method === "POST") {
        const body = JSON.parse(init?.body || "{}");
        onCreate?.(body);
        return json({ id: "b-new", ...body });
      }
      if (u.includes("/api/v1/backups")) {
        return json(backups);
      }
      if (u.includes("/api/v1/connect/status")) {
        return json(connect);
      }
      if (u.includes("/api/v1/connect/backup-sources") && method === "POST") {
        const body = JSON.parse(init?.body || "{}");
        onBackupSources?.(body.sources);
        return json({ ok: true });
      }
      return new Response("{}", { status: 500 });
    }),
  );
}

function renderSheet(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ToastProvider>
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <ProtectSheet driveId="d1" path="photos" onClose={() => {}} {...props} />
          <Toaster />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
    </ToastProvider>,
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
  it("lets an admin back up a folder onto another drive", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [],
      onCreate,
    });
    renderSheet();
    expect(await screen.findByRole("heading", { name: /Back up/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /On other drives/i })).toBeInTheDocument();
    expect(screen.getByText(/Private items inside aren't included/)).toBeInTheDocument();
    const choose = await screen.findByRole("button", { name: "Choose a drive" });
    // Dropdown sits on the inverted option panel (surface-primary), so it uses the card surface.
    expect(choose.className).toMatch(/surface-secondary/);
    expect(screen.queryByRole("button", { name: "New link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grant access" })).not.toBeInTheDocument();

    await user.click(choose);
    await user.click(await screen.findByRole("option", { name: "Backup" }));
    await user.click(screen.getByRole("button", { name: "Back up" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        source_drive_id: "d1",
        source_path: "photos",
        target_drive_id: "d2",
      }),
    );
    expect(await screen.findByText("Backup started.")).toBeInTheDocument();
  });

  it("explains when a second drive is missing but still shows cloud", async () => {
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      backups: [],
      connect: { backup_unlocked: false, backup_sources: [] },
    });
    renderSheet();
    expect(await screen.findByText(/Needs another drive/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /In the cloud/i })).toBeInTheDocument();
    expect(screen.getByText(/Add a card at connect\.luna\.libreloom\.org/i)).toBeInTheDocument();
  });

  it("lists each backup and offers the drives not used yet", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
        { id: "d3", label: "Archive", mount_point: "/mnt/archive" },
      ],
      backups: [
        backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: nowSeconds() }),
      ],
    });
    renderSheet();
    expect(await screen.findByText(/Backed up just now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add another drive" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Choose a drive" }));
    expect(screen.queryByRole("option", { name: "Backup" })).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Archive" })).toBeInTheDocument();
  });

  it("hides the add form when every other drive already has a backup", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: 0, first_done: false })],
    });
    renderSheet();
    expect(await screen.findByText(/First backup in progress/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add another drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose a drive" })).not.toBeInTheDocument();
  });

  it("shows why a backup is out of date", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [
        backup({
          id: "b1",
          target_drive: "d2",
          target_drive_name: "Backup",
          last_ok_at: 0,
          last_error: "Luna can't find the drive Backup, so photos wasn't copied.",
          state: "failing",
        }),
      ],
    });
    renderSheet();
    expect(
      await screen.findByText("Luna can't find the drive Backup, so photos wasn't copied."),
    ).toBeInTheDocument();
    expect(screen.getByText("Last full copy: never")).toBeInTheDocument();
  });

  it("says nothing extra while a backup is working", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [
        backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: nowSeconds() }),
      ],
    });
    renderSheet();
    expect(await screen.findByText(/Backed up just now/)).toBeInTheDocument();
    expect(screen.queryByText(/Last full copy/)).not.toBeInTheDocument();
  });

  it("says a Back up now that finished is up to date", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: nowSeconds() })],
      onRun,
      runReply: { status: 200, body: { done: true } },
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Backup is up to date.")).toBeInTheDocument();
    expect(onRun).toHaveBeenCalledWith({});
  });

  it("says when a long Back up now is still copying", async () => {
    const user = userEvent.setup();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: 0 })],
      runReply: { status: 200, body: { done: false } },
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText(/Luna is still copying/)).toBeInTheDocument();
  });

  it("shows the reason when Back up now fails", async () => {
    const user = userEvent.setup();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: 0 })],
      runReply: { status: 409, body: { error: "Backup is full, so the copy of photos stopped." } },
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Backup is full, so the copy of photos stopped.")).toBeInTheDocument();
  });

  it("offers Run anyway for a blocked mass-delete and sends the override", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [
        backup({
          id: "b1",
          target_drive: "d2",
          target_drive_name: "Backup",
          hard: true,
          last_error: "Most of the files in photos would be deleted, so Luna stopped.",
          state: "failing",
        }),
      ],
      onRun,
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Run anyway" }));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith({ allow_mass_delete: true }));
  });

  it("confirms before deleting a backup and names the target drive", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: 0 })],
      onDelete,
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Delete backup" }));
    const dialog = await screen.findByRole("dialog", { name: /Delete backup\?/ });
    expect(within(dialog).getByText(/Deletes the backup and every saved copy on/)).toBeInTheDocument();
    expect(within(dialog).getByText("Backup")).toBeInTheDocument();
    expect(within(dialog).getByText(/The original files stay/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete backup" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(expect.stringContaining("/api/v1/backups/b1")));
    expect(await screen.findByText("Backup deleted.")).toBeInTheDocument();
  });

  it("shows a stopped backup with its reason and only Delete", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [
        backup({
          id: "b1",
          target_drive: "d2",
          target_drive_name: "Backup",
          status: "stopped",
          stop_reason: "The Backup drive was removed from Luna.",
        }),
      ],
    });
    renderSheet();
    expect(await screen.findByText("The Backup drive was removed from Luna.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete backup" })).toBeInTheDocument();
  });

  it("shows a cloud backup problem on the cloud row", async () => {
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: {
        backup_unlocked: true,
        backup_sources: [{ kind: "folder", path: "/mnt/main/photos" }],
        backup_status: {
          state: "failing",
          last_ok_at: 0,
          last_error: "Cloud backup for this account is full. Remove some files, then try again.",
        },
      },
    });
    renderSheet();
    expect(
      await screen.findByText(
        "Cloud backup for this account is full. Remove some files, then try again.",
      ),
    ).toBeInTheDocument();
  });

  it("lets an admin start cloud backup when unlocked", async () => {
    const user = userEvent.setup();
    /** @type {unknown} */
    let saved = null;
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      backups: [],
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
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Other", mount_point: "/mnt/other" },
      ],
      backups: [],
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
        if (u.includes("/api/v1/backups")) {
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
        if (u.includes("/api/v1/backups")) {
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

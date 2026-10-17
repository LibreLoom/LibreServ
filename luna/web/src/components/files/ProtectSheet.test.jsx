import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import ProtectSheet from "./ProtectSheet";
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

function cloudBackup(overrides = {}) {
  return {
    id: "c1",
    kind: "folder",
    source_drive: "d1",
    source_drive_name: "Main",
    source_path: "photos",
    source_name: "photos",
    state: "ok",
    status: "active",
    stop_reason: "",
    last_error: "",
    last_ok_at: nowSeconds(),
    size: 0,
    can_delete: true,
    running: false,
    ...overrides,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubBackupApi({
  drives = [],
  backups = [],
  cloudBackups = [],
  connect = { connect_active: false },
  onCreate,
  onRun,
  onDelete,
  onCloudCreate,
  onCloudRun,
  onCloudDelete,
  cloudCreateGate,
  runReply = { status: 200, body: { done: true } },
  cloudRunReply = { status: 200, body: { done: true } },
  deleteReply = { status: 200, body: {} },
} = /** @type {{
  drives?: any[],
  backups?: any[],
  cloudBackups?: any[],
  connect?: { connect_active: boolean, card_on_file?: boolean },
  onCreate?: (body: any) => void,
  onRun?: (body: any) => void,
  onDelete?: (url: string) => void,
  onCloudCreate?: (body: any) => void,
  onCloudRun?: (url: string) => void,
  onCloudDelete?: (url: string) => void,
  cloudCreateGate?: Promise<unknown>,
  runReply?: { status: number, body: any },
  cloudRunReply?: { status: number, body: any },
  deleteReply?: { status: number, body: any },
}} */ ({})) {
  // The cloud list changes when a backup is created or deleted, like the server's does.
  const cloud = cloudBackups.map((b) => ({ ...b }));
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
      if (u.startsWith("/api/v1/cloud/backups")) {
        if (method === "POST" && u.endsWith("/run")) {
          onCloudRun?.(u);
          return json(cloudRunReply.body, cloudRunReply.status);
        }
        if (method === "DELETE") {
          onCloudDelete?.(u);
          const id = u.split("/").pop();
          const index = cloud.findIndex((b) => b.id === id);
          if (index >= 0) cloud.splice(index, 1);
          return json(deleteReply.body, deleteReply.status);
        }
        if (method === "POST") {
          const body = JSON.parse(init?.body || "{}");
          await cloudCreateGate;
          onCloudCreate?.(body);
          const created = cloudBackup({
            id: "c-new",
            source_drive: body.source_drive_id,
            source_path: body.source_path,
            source_name: body.source_path,
            last_ok_at: 0,
          });
          cloud.push(created);
          return json(created);
        }
        return json(cloud);
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
      connect: { connect_active: false },
    });
    renderSheet();
    expect(await screen.findByText(/Needs another drive/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /In the cloud/i })).toBeInTheDocument();
    expect(screen.getByText(/Link this Luna to Luna Connect/)).toBeInTheDocument();
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

  it("shows a Back up now problem on the sheet, not as a success", async () => {
    const user = userEvent.setup();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", last_ok_at: 0 })],
      runReply: {
        status: 200,
        body: { done: false, problem: "Luna couldn't read the drive Main. Check it is plugged in." },
      },
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(
      await screen.findByText("Luna couldn't read the drive Main. Check it is plugged in."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Luna is still copying/)).not.toBeInTheDocument();
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
      connect: { connect_active: true },
      cloudBackups: [
        cloudBackup({
          state: "failing",
          last_ok_at: 0,
          last_error: "Cloud backup for this account is full. Remove some files, then try again.",
        }),
      ],
    });
    renderSheet();
    expect(
      await screen.findByText(
        "Cloud backup for this account is full. Remove some files, then try again.",
      ),
    ).toBeInTheDocument();
  });

  it("lets an admin back up a folder to the cloud when connected", async () => {
    const user = userEvent.setup();
    const onCloudCreate = vi.fn();
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true },
      cloudBackups: [],
      onCloudCreate,
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Back up to the cloud" }));
    await waitFor(() =>
      expect(onCloudCreate).toHaveBeenCalledWith({ source_drive_id: "d1", source_path: "photos" }),
    );
    expect(await screen.findByText("Cloud backup started.")).toBeInTheDocument();
  });

  it("confirms before deleting a cloud backup and calls the cloud delete route", async () => {
    const user = userEvent.setup();
    const onCloudDelete = vi.fn();
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true },
      cloudBackups: [cloudBackup({ id: "c1" })],
      onCloudDelete,
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Delete cloud backup" }));
    const dialog = await screen.findByRole("dialog", { name: /Delete cloud backup\?/ });
    expect(within(dialog).getByText(/The original files stay/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete cloud backup" }));
    await waitFor(() =>
      expect(onCloudDelete).toHaveBeenCalledWith(expect.stringContaining("/api/v1/cloud/backups/c1")),
    );
    expect(await screen.findByText("Cloud backup deleted.")).toBeInTheDocument();
  });

  it("asks for a payment card instead of offering cloud backup when no card is on file", async () => {
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true, card_on_file: false },
      cloudBackups: [],
    });
    renderSheet();
    expect(await screen.findByText(/Add a payment card at Luna Connect/)).toBeInTheDocument();
    expect(screen.getByText("connect.luna.libreloom.org")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up to the cloud" })).not.toBeInTheDocument();
  });

  it("keeps Back up to the cloud disabled while it is being added, then shows the cloud row", async () => {
    const user = userEvent.setup();
    /** @type {((value?: unknown) => void) | undefined} */
    let resolveCreate;
    const createGate = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true },
      cloudBackups: [],
      cloudCreateGate: createGate,
    });
    renderSheet();
    const btn = await screen.findByRole("button", { name: "Back up to the cloud" });
    expect(btn).not.toBeDisabled();

    await user.click(btn);

    // While in-flight, the button is loading and disabled
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");

    // Complete the POST; the list refetches and the cloud row replaces the button
    resolveCreate?.();

    expect(await screen.findByRole("button", { name: "Delete cloud backup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up to the cloud" })).not.toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
  });
});

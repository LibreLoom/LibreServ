import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../context/AuthContext";
import ProtectSheet, { ProtectButton } from "./ProtectSheet";
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
  privateItem = { private: false, inside_private: false, mine: false, owner_name: "" },
  onOldCopiesDelete,
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
  privateItem?: { private: boolean, inside_private: boolean, mine: boolean, owner_name: string },
  onOldCopiesDelete?: (url: string) => void,
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
      if (u.startsWith("/api/v1/private-backups/item")) {
        return json(privateItem);
      }
      if (u.startsWith("/api/v1/private-backups/old-copies") && method === "DELETE") {
        onOldCopiesDelete?.(u);
        return json({ ok: true });
      }
      if (u.startsWith("/api/v1/cloud/backups")) {
        if (method === "POST" && /\/run(\?|$)/.test(u)) {
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

function renderSheet(props = {}, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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

  it("asks for a payment card and keeps Back up to the cloud usable when no card is on file", async () => {
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true, card_on_file: false },
      cloudBackups: [],
    });
    renderSheet();
    expect(await screen.findByText(/Add a payment card at Luna Connect/)).toBeInTheDocument();
    expect(screen.getByText("connect.luna.libreloom.org")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back up to the cloud" })).not.toBeDisabled();
  });

  it("offers Back up anyway when a cloud run says the source looks missing, and sends accept_missing", async () => {
    const user = userEvent.setup();
    const onCloudRun = vi.fn();
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true },
      cloudBackups: [cloudBackup({ id: "c1" })],
      cloudRunReply: {
        status: 200,
        body: { done: false, problem: "Luna cannot find this folder on the drive.", source_missing: true },
      },
      onCloudRun,
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Luna cannot find this folder on the drive.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back up anyway" }));
    await waitFor(() =>
      expect(onCloudRun).toHaveBeenLastCalledWith(
        expect.stringContaining("/api/v1/cloud/backups/c1/run?accept_missing=true"),
      ),
    );
  });

  it("does not offer Back up anyway to someone who cannot delete the cloud backup", async () => {
    const user = userEvent.setup();
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true },
      cloudBackups: [cloudBackup({ id: "c1", can_delete: false })],
      cloudRunReply: {
        status: 200,
        body: { done: false, problem: "Luna cannot find this folder on the drive.", source_missing: true },
      },
    });
    renderSheet();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Luna cannot find this folder on the drive.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up anyway" })).not.toBeInTheDocument();
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

  it("someone else's private item says who can back it up and hides create buttons", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [backup({ id: "b1", target_drive: "d2", target_drive_name: "Backup", can_delete: false })],
      connect: { connect_active: true },
      cloudBackups: [cloudBackup({ id: "c1" })],
      privateItem: { private: true, inside_private: false, mine: false, owner_name: "Sam" },
    });
    renderSheet();
    expect(await screen.findByText("Sam")).toBeInTheDocument();
    expect(screen.getByText(/can back up this item/)).toBeInTheDocument();
    // The existing drive backup still lists, without Run or Delete.
    expect(screen.getByText("Backup")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete backup" })).not.toBeInTheDocument();
    // No create controls, and the cloud section is hidden.
    expect(screen.queryByText(/Back up to/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose a drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /In the cloud/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete cloud backup" })).not.toBeInTheDocument();
  });

  it("inside a private item points to the item's own shield", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [],
      connect: { connect_active: true },
      cloudBackups: [],
      privateItem: { private: false, inside_private: true, mine: false, owner_name: "" },
    });
    renderSheet();
    expect(await screen.findByText("Back up the private item itself, from its own shield.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose a drive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back up to the cloud" })).not.toBeInTheDocument();
  });

  it("owner sees both sections and the owner line", async () => {
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [],
      connect: { connect_active: true },
      cloudBackups: [cloudBackup({ id: "c1" })],
      privateItem: { private: true, inside_private: false, mine: true, owner_name: "Max" },
    });
    renderSheet();
    expect(await screen.findByText("Only you can back this up. Its cloud copy opens only with your recovery phrase.")).toBeInTheDocument();
    expect(screen.getByText(/Private items inside aren't included/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /On other drives/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /In the cloud/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete cloud backup" })).toBeInTheDocument();
  });

  it("old phrase versions show with Remove now; confirming calls DELETE and toasts", async () => {
    const user = userEvent.setup();
    const onOldCopiesDelete = vi.fn();
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true },
      cloudBackups: [
        cloudBackup({
          id: "c1",
          old_phrase_copies: { count: 2, removed_at: Math.floor(Date.UTC(2026, 2, 3, 12) / 1000) },
        }),
      ],
      onOldCopiesDelete,
    });
    renderSheet();
    expect(await screen.findByText(/Older versions made with your old recovery phrase/)).toBeInTheDocument();
    expect(screen.getByText(/removed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove now" }));
    const dialog = await screen.findByRole("dialog", { name: /Remove older cloud versions\?/ });
    expect(within(dialog).getByText(/will be gone/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(onOldCopiesDelete).toHaveBeenCalledWith(expect.stringContaining("/api/v1/private-backups/old-copies")),
    );
    expect(await screen.findByText("Older versions will be removed")).toBeInTheDocument();
  });

  it("refreshes the private backup lists when a backup is created from the sheet", async () => {
    const user = userEvent.setup();
    stubBackupApi({
      drives: [
        { id: "d1", label: "Main", mount_point: "/mnt/main" },
        { id: "d2", label: "Backup", mount_point: "/mnt/backup" },
      ],
      backups: [],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderSheet({}, client);
    const choose = await screen.findByRole("button", { name: "Choose a drive" });
    await user.click(choose);
    await user.click(await screen.findByRole("option", { name: "Backup" }));
    await user.click(screen.getByRole("button", { name: "Back up" }));
    expect(await screen.findByText("Backup started.")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["private-backups-summary"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["private-backups-mine"] });
  });

  it("refreshes the private backup lists when a cloud backup is deleted from the sheet", async () => {
    const user = userEvent.setup();
    stubBackupApi({
      drives: [{ id: "d1", label: "Main", mount_point: "/mnt/main" }],
      connect: { connect_active: true },
      cloudBackups: [cloudBackup({ id: "c1" })],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderSheet({}, client);
    await user.click(await screen.findByRole("button", { name: "Delete cloud backup" }));
    const dialog = await screen.findByRole("dialog", { name: /Delete cloud backup\?/ });
    await user.click(within(dialog).getByRole("button", { name: "Delete cloud backup" }));
    expect(await screen.findByText("Cloud backup deleted.")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["private-backups-summary"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["private-backups-mine"] });
  });
});

describe("ProtectButton", () => {
  it("shows Not backed up beside the shield and keeps the Back up label", () => {
    const onClick = vi.fn();
    render(<ProtectButton label="Taxes" notBackedUp onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Back up Taxes" });
    expect(within(button).getByText("Not backed up")).toBeInTheDocument();
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

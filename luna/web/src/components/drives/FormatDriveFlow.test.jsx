import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { previewHeadline } from "../../lib/driveFormat.js";
import FormatDriveFlow from "./FormatDriveFlow.jsx";

afterEach(() => vi.unstubAllGlobals());

const ok = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const nowS = () => Math.floor(Date.now() / 1000);

const FILES_PART = {
  name: "sdb1", size_bytes: 32_000_000_000, fs_type: "exfat", label: "BACKUP2019", state: "has_files",
  used_bytes: 12_000_000_000, folders: 2, files: 3, unreadable: 0,
  entries: [{ name: "Family photos", kind: "folder" }, { name: "Tax 2024", kind: "folder" }, { name: "passport-scan.pdf", kind: "file" }],
};

function preview(over = {}) {
  const now = nowS();
  return {
    preview_id: "p1", now, issued_at: now, ready_at: now + 30, expires_at: now + 900, wait_seconds: 30,
    empty: false, blank: false, can_encrypt: true, registered_drive_id: null, signatures: ["gpt", "exfat"],
    device: { name: "sdb", model: "SanDisk USB stick", size_bytes: 32_000_000_000, serial: "ABC123", wwn: null },
    partitions: [FILES_PART], used_bytes: 12_000_000_000, ...over,
  };
}

const PHASES = ["preparing", "releasing", "erasing", "partitioning", "formatting", "registering"];
const run = (over = {}) => ({
  id: "fr1", device: "sdb", drive_id: null, encrypted: false, phase: "erasing", phases: PHASES,
  done: false, failed: false, error: null, erased: false, started_at: nowS(), finished_at: null, ...over,
});

/**
 * Answers by route; `calls` records every request so a test can look at what was sent.
 * @param {{ previewBody?: any, startBody?: any, startError?: any, statusBody?: any, statusError?: any }} [opts]
 */
function stub({ previewBody = preview(), startBody = run(), startError, statusBody = run(), statusError } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/drive-format/preview")) return ok(previewBody);
    if (u.endsWith("/drive-format/start")) return startError ? ok(startError.body, startError.status) : ok(startBody, 202);
    if (u.includes("/drive-format/")) return statusError ? ok(statusError.body, statusError.status) : ok(statusBody);
    return new Response("{}", { status: 404 });
  }));
  return calls;
}

function show(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handlers = { onDone: vi.fn(), onCancel: vi.fn() };
  render(
    <ToastProvider>
      <QueryClientProvider client={client}>
        <FormatDriveFlow device={{ name: "sdb", model: "SanDisk USB stick" }} {...handlers} {...props} />
      </QueryClientProvider>
    </ToastProvider>,
  );
  return handlers;
}

// The dialog title is present while the preview is still loading.
const looked = () => screen.findByRole("button", { name: /^Erase drive/ });

describe("FormatDriveFlow", () => {
  it("shows what is on the drive before anything else", async () => {
    stub();
    show();
    expect(await screen.findByText("This drive has files on it.")).toBeInTheDocument();
    expect(screen.getByText("BACKUP2019")).toBeInTheDocument();
    expect(screen.getByText("Family photos")).toBeInTheDocument();
    expect(screen.getByText("passport-scan.pdf")).toBeInTheDocument();
    expect(screen.getByText(/2 folders, 3 files, 12 GB used/)).toBeInTheDocument();
    // The contents and the Erase button share one screen: nothing to fill in.
    expect(screen.getByRole("button", { name: /^Erase drive/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says plainly when Luna can't read the drive, installer media or a locked part", async () => {
    stub({
      previewBody: preview({
        partitions: [
          { ...FILES_PART, name: "sdb1", label: "", state: "unreadable", used_bytes: null, folders: 0, files: 0, entries: [] },
          { ...FILES_PART, name: "sdb2", label: "", state: "locked", used_bytes: null, folders: 0, files: 0, entries: [] },
          { ...FILES_PART, name: "sdb3", label: "", state: "unknown_filesystem", used_bytes: null, folders: 0, files: 0, entries: [] },
        ],
      }),
    });
    show();
    expect(await screen.findByText("Luna can't read this drive.")).toBeInTheDocument();
    expect(screen.getByText(/This part may be damaged, so Luna can't show its files/)).toBeInTheDocument();
    expect(screen.getByText(/locked with a password/)).toBeInTheDocument();
    expect(screen.getByText(/doesn't recognise how this part is set up/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/filesystem|partition|LUKS|exFAT/i);
  });

  it("calls a drive made only of locked parts protected, not unreadable", async () => {
    const locked = { ...FILES_PART, label: "", state: "locked", used_bytes: null, folders: 0, files: 0, entries: [] };
    const allLocked = preview({ partitions: [{ ...locked, name: "sdb1" }, { ...locked, name: "sdb2" }] });
    // A whole drive behind a password is sealed, not damaged: careful, not an error.
    expect(previewHeadline(allLocked)).toEqual({ title: "This drive is protected with a password.", tone: "careful" });
    stub({ previewBody: allLocked });
    show();
    expect(await screen.findByText("This drive is protected with a password.")).toBeInTheDocument();
    expect(screen.getAllByText(/locked with a password/)).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/damaged|Luna can't read this drive/i);
  });

  it("calls an installer disk by name", async () => {
    stub({ previewBody: preview({ partitions: [{ ...FILES_PART, label: "UBUNTU", state: "installer_media", used_bytes: null, folders: 0, files: 0, entries: [] }] }) });
    show();
    expect(await screen.findByText("This looks like an installer disk.")).toBeInTheDocument();
  });

  it("makes a drive that isn't verified empty wait, counted from the server's clock", async () => {
    // This browser's clock is an hour fast: the wait must still be about 30 s.
    const server = nowS() - 3600;
    stub({ previewBody: preview({ now: server, issued_at: server, ready_at: server + 30, expires_at: server + 900 }) });
    show();
    await looked();
    const erase = screen.getByRole("button", { name: /^Erase drive \((29|30)\)$/ });
    expect(erase).toBeDisabled();
    expect(screen.queryByRole("textbox")).toBeNull();
    // Nothing to choose: no filesystem, no encryption.
    expect(screen.queryByText(/filesystem|exFAT|encrypt/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("lets an empty drive be erased at once, keeping the drive's name", async () => {
    const calls = stub({ previewBody: preview({ empty: true, blank: true, partitions: [], used_bytes: null, ready_at: nowS() }) });
    show();
    expect(await screen.findByText("This drive is blank.")).toBeInTheDocument();
    await looked();
    const erase = screen.getByRole("button", { name: "Erase drive" });
    expect(erase).toBeEnabled();
    fireEvent.click(erase);
    expect(await screen.findByRole("list", { name: "Erase progress" })).toBeInTheDocument();
    const start = calls.find((c) => c.url.endsWith("/start"));
    expect(start.body).toEqual({ preview_id: "p1", label: "SanDisk USB stick" });
  });

  it("sends the password it was given, and leaves the no-recovery warning to the caller", async () => {
    const calls = stub({ previewBody: preview({ empty: true, partitions: [], ready_at: nowS() }) });
    show({ password: "correct horse 42" });
    await looked();
    expect(screen.getByText("Luna protects the drive with your password.")).toBeInTheDocument();
    expect(screen.queryByText(/no way to recover/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Erase drive" }));
    await screen.findByRole("list", { name: "Erase progress" });
    expect(calls.find((c) => c.url.endsWith("/start")).body.password).toBe("correct horse 42");
    expect(calls.every((c) => !c.url.includes("correct"))).toBe(true);
  });

  it("refuses a password for a drive that can't be protected, before anything is sent", async () => {
    stub({ previewBody: preview({ empty: true, partitions: [], can_encrypt: false, ready_at: nowS() }) });
    show({ password: "correct horse 42" });
    await looked();
    expect(screen.getByText(/test drive made from a folder/)).toBeInTheDocument();
    // Never promise the password in the same breath as refusing it.
    expect(screen.queryByText(/protects the drive with your password/)).toBeNull();
    expect(screen.getByRole("button", { name: "Erase drive" })).toBeDisabled();
  });

  it("says one plain sentence for a refused start and offers a fresh look when the preview is stale", async () => {
    stub({
      previewBody: preview({ empty: true, partitions: [], ready_at: nowS() }),
      startError: { status: 409, body: { error: "raw server text", code: "preview_stale" } },
    });
    show();
    await looked();
    fireEvent.click(screen.getByRole("button", { name: "Erase drive" }));
    expect(await screen.findByText("Something on this drive changed since you looked. Look at the drive again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look at the drive again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erase drive" })).toBeNull();
  });

  it("reopens a run in progress without looking at the drive again", async () => {
    const calls = stub({ statusBody: run({ phase: "partitioning" }) });
    show({ device: { name: "sdb", format_id: "fr1" } });
    const steps = await screen.findByRole("list", { name: "Erase progress" });
    expect(within(steps).getByText("Erasing the old contents")).toBeInTheDocument();
    expect(within(steps).getByText("Preparing the drive").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/You can close this window/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/preview"))).toBe(false);
  });

  it("opens the drive when the erase is done", async () => {
    stub({ statusBody: run({ done: true, erased: true, drive_id: "d9", phase: "registering" }) });
    const { onDone } = show({ device: { name: "sdb", format_id: "fr1", label: "Photos" } });
    expect(await screen.findByText("Drive is ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open drive" }));
    expect(onDone).toHaveBeenCalledWith("d9");
  });

  it("says what happened when the erase fails, and whether anything was erased", async () => {
    stub({ statusBody: run({ failed: true, erased: true, error: "This drive stopped responding, so Luna couldn't erase it. Unplug it, plug it back in, and try again." }) });
    show({ device: { name: "sdb", format_id: "fr2" } });
    expect(await screen.findByText(/stopped responding/)).toBeInTheDocument();
    expect(screen.getByText("The old files may already be gone from this drive.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look at the drive again" })).toBeInTheDocument();
  });

  it("says nothing was erased when it failed before writing", async () => {
    stub({ statusBody: run({ failed: true, erased: false, error: "Something is still using this drive." }) });
    show({ device: { name: "sdb", format_id: "fr3" } });
    expect(await screen.findByText("Nothing was erased. The drive is as it was.")).toBeInTheDocument();
  });

  it("explains a lost record instead of guessing", async () => {
    stub({ statusError: { status: 404, body: { error: "gone", code: "format_not_found" } } });
    show({ device: { name: "sdb", format_id: "fr4" } });
    expect(await screen.findByText(/Luna lost track of this erase/)).toBeInTheDocument();
  });

  it("says when the drive can't be looked at", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ error: "Luna can't see a drive with that name." }, 404)));
    show();
    expect(await screen.findByText("Luna can't see a drive with that name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("closes through onCancel", async () => {
    stub();
    const { onCancel } = show();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });
});

// Erasing a drive: preview, start, status. Copies crates/lunad/src/api/drive_format.rs
// and drives/format/mod.rs: Admin only, a preview the server dates (all times are unix
// seconds), a 30 s wait unless the drive is verified empty, the named phases, and the
// start error codes.
//
// A run has no timers. Its phase is worked out from the time since it started, every
// time someone asks, so a page reload (the world is saved in sessionStorage) finds the
// run exactly where the clock says it is.
//
// What a scenario can set on a detected drive (all optional):
//   entries, fs_type, readable, needs_setup, encrypted, unreadable   what the other fake drive routes use
//   blank           nothing identifiable on it (default: no fs_type and no entries)
//   preview         { partitions, signatures, empty, serial } replaces what is worked out
//   formatPhaseMs   how long each phase lasts (default 1500)
//   formatFailAt    a phase name: the run fails when it reaches it
//   formatFailMessage
//   mock            a dev directory drive: no passwords
//   missingTool, busy, swappedAtStart, filesAppearedAtStart   make start refuse
import { fail, json, get, post } from "../engine.js";
import { isAdmin, requireAdmin } from "../policy.js";
import { nextId, summary } from "../world.js";
import { fsOf, nowS } from "../fsmodel.js";

const ADMIN_ONLY = "Only an Admin can manage drives.";
const WAIT_SECONDS = 30;
const EXPIRES_SECONDS = 15 * 60;
const SEQUENCE = ["preparing", "releasing", "erasing", "partitioning", "encrypting", "formatting", "registering"];
const phasesFor = (encrypted) => SEQUENCE.filter((p) => encrypted || p !== "encrypting");
const ERASED_FROM = "erasing";

const BUSY = "Luna is already working on this drive. Wait until it finishes.";
const FAILURE_TEXT = {
  releasing: "Something is still using this drive, so Luna can't erase it. Close whatever has it open, then try again.",
  partitioning: "This drive stopped responding, so Luna couldn't erase it. Unplug it, plug it back in, and try again.",
  formatting: "This drive stopped responding, so Luna couldn't erase it. Unplug it, plug it back in, and try again.",
};

const runs = (world) => (world.formatRuns ??= {});
const previews = (world) => (world.formatPreviews ??= {});

/** The registered drive that lives on this disk, like format::registered_on. */
const registeredOn = (world, device) => world.drives.find((d) => d.device === device && d.state !== "missing") ?? null;
const detectedOn = (world, device) => world.detected.find((d) => d.name === device) ?? null;

/** Where a run is now, and what that means for the world. Safe to call again and again. */
function statusOf(world, run) {
  const phases = run.phases;
  const elapsed = Date.now() - run.startedMs;
  const index = Math.floor(elapsed / run.phaseMs);
  const failAt = run.failAt ? phases.indexOf(run.failAt) : -1;
  const out = {
    id: run.id,
    device: run.device,
    drive_id: run.driveId,
    encrypted: run.encrypted,
    phase: phases[Math.min(index, phases.length - 1)],
    phases,
    done: false,
    failed: false,
    error: null,
    erased: false,
    started_at: run.startedAt,
    finished_at: null,
  };
  if (failAt >= 0 && index >= failAt) {
    out.phase = phases[failAt];
    out.failed = true;
    out.error = run.failMessage || FAILURE_TEXT[run.failAt] || "Luna ran into a problem while erasing this drive.";
    out.erased = failAt >= phases.indexOf(ERASED_FROM);
    out.finished_at = run.startedAt + Math.ceil(((failAt + 1) * run.phaseMs) / 1000);
    return out;
  }
  if (index >= phases.length) {
    settle(world, run);
    out.done = true;
    out.erased = true;
    out.drive_id = run.driveId;
    out.finished_at = run.startedAt + Math.ceil((phases.length * run.phaseMs) / 1000);
  }
  return out;
}

/** What a finished run leaves behind: the drive is registered (or renamed) under its new name. */
function settle(world, run) {
  if (run.settled) return;
  run.settled = true;
  const existing = run.driveId ? world.drives.find((d) => d.id === run.driveId) : null;
  if (existing) {
    existing.label = run.label;
    existing.state = "as_is";
    existing.fs_type = run.encrypted ? "ext4" : "exfat";
    existing.mounted = true;
    // The run leaves an encrypted drive open; a plain reformat clears the flag.
    existing.encrypted = run.encrypted;
    existing.locked = false;
    existing.password = run.password;
    world.fs = { ...(world.fs || {}), [existing.id]: { nodes: {}, trash: [] } };
    world.summaries[existing.id] = summary(existing.id, { used_bytes: 0, shortcuts: [] });
    return;
  }
  const id = nextId("d");
  run.driveId = id;
  world.detected = world.detected.filter((d) => d.name !== run.device);
  world.drives.push({
    id, label: run.label, state: "as_is", device: run.device, fs_type: run.encrypted ? "ext4" : "exfat",
    mount_point: `/mnt/${id}`, mounted: true, encrypted: run.encrypted, locked: false, password: run.password,
  });
  world.fs = { ...(world.fs || {}), [id]: { nodes: {}, trash: [] } };
  world.summaries[id] = summary(id, { used_bytes: 0, shortcuts: [] });
}

/**
 * The run in progress on this disk, if any. The drive lists call this: they send
 * `formatting` and `format_id` only while it is true, like lunad.
 */
export function activeRun(world, device) {
  const run = Object.values(runs(world)).find((r) => r.device === device);
  if (!run) return null;
  const s = statusOf(world, run);
  return s.done || s.failed ? null : s;
}

/** The extra keys a drive row carries while it is being erased. */
export function formatFields(world, user, device) {
  const s = activeRun(world, device);
  if (!s) return {};
  return { formatting: true, ...(isAdmin(user) ? { format_id: s.id } : {}) };
}

// ── What the disk holds ─────────────────────────────────────────────────────

const GB = 1_000_000_000;

function detectedPreview(d) {
  const entries = d.entries ?? [];
  const folders = entries.filter((e) => e.kind === "folder").length;
  const files = entries.length - folders;
  const size = d.size_bytes ?? 0;
  const blank = d.blank ?? (!d.fs_type && entries.length === 0 && !d.encrypted);
  if (d.preview?.partitions) {
    return { blank: Boolean(d.preview.blank), signatures: d.preview.signatures ?? ["gpt"], partitions: d.preview.partitions, empty: d.preview.empty ?? false, serial: d.preview.serial ?? null };
  }
  if (blank) return { blank: true, signatures: [], partitions: [], empty: true, serial: null };
  let state = "has_files";
  if (d.encrypted) state = "locked";
  else if (d.fs_type === "iso9660") state = "installer_media";
  else if (d.readable === false) state = d.fs_type ? "unreadable" : "unknown_filesystem";
  else if (entries.length === 0) state = "empty";
  const listed = state === "has_files" || state === "empty";
  const part = {
    name: `${d.name}1`, size_bytes: size, fs_type: d.fs_type ?? "", label: d.volume_label ?? "", state,
    used_bytes: listed ? Math.round(size * 0.4) : null,
    folders: listed ? folders : 0, files: listed ? files : 0, unreadable: listed ? d.unreadable ?? 0 : 0,
    entries: listed ? [...entries].sort((a, b) => Number(a.kind !== "folder") - Number(b.kind !== "folder") || a.name.localeCompare(b.name)) : [],
  };
  return { blank: false, signatures: ["gpt", d.fs_type ?? "unknown"], partitions: [part], empty: state === "empty", serial: d.serial ?? null };
}

function registeredPreview(world, row) {
  const fs = fsOf(world, row.id);
  const top = Object.entries(fs.nodes).filter(([p]) => p && !p.includes("/"));
  const entries = top.map(([p, n]) => ({ name: p, kind: n.kind === "dir" ? "folder" : "file" }))
    .sort((a, b) => Number(a.kind !== "folder") - Number(b.kind !== "folder") || a.name.localeCompare(b.name));
  const folders = entries.filter((e) => e.kind === "folder").length;
  const sum = world.summaries[row.id];
  const size = sum?.total_bytes ?? 64 * GB;
  // Like inspect.rs: a locked container can't be read, so it shows as locked with nothing
  // listed and always waits; an unlocked one is read through its live mount.
  const sealed = Boolean(row.encrypted && row.locked);
  const part = {
    name: `${row.device}1`, size_bytes: size, fs_type: row.encrypted ? "crypto_LUKS" : row.fs_type ?? "exfat", label: row.encrypted ? "" : row.label,
    state: sealed ? "locked" : entries.length === 0 ? "empty" : "has_files", used_bytes: sealed ? null : sum?.used_bytes ?? null,
    folders: sealed ? 0 : folders, files: sealed ? 0 : entries.length - folders, unreadable: 0, entries: sealed ? [] : entries,
  };
  return { blank: false, signatures: ["gpt", part.fs_type], partitions: [part], empty: !sealed && entries.length === 0, serial: row.serial ?? null };
}

// ── Routes ──────────────────────────────────────────────────────────────────

post("/api/v1/drive-format/preview", ({ world, user, body }) => {
  requireAdmin(user, ADMIN_ONLY);
  const name = String(body.device ?? "").trim();
  const detected = detectedOn(world, name);
  const registered = registeredOn(world, name);
  if (!detected && !registered) return fail(404, "Luna can't see a drive with that name.");
  if (activeRun(world, name) || detected?.busy) return fail(409, BUSY, "drive_busy");
  const knob = detected ?? {};
  if (knob.systemDisk) return fail(400, "That's the drive Luna runs from. Luna won't erase it.", "system_disk");
  if (knob.previewFails) return fail(500, "Luna couldn't look at this drive. Try again.");
  const found = registered && !detected ? registeredPreview(world, registered) : detectedPreview(detected);
  const now = nowS();
  const ready = found.empty ? now : now + WAIT_SECONDS;
  const id = nextId("fp");
  const identity = {
    name, model: detected?.model ?? registered?.label ?? "", size_bytes: detected?.size_bytes ?? world.summaries[registered?.id]?.total_bytes ?? 0,
    serial: found.serial, wwn: null,
  };
  previews(world)[id] = { id, device: name, issuedAt: now, readyAt: ready, expiresAt: now + EXPIRES_SECONDS, empty: found.empty, registeredDrive: registered?.id ?? null };
  const used = found.partitions.map((p) => p.used_bytes).filter((n) => n != null);
  return {
    preview_id: id, now, issued_at: now, ready_at: ready, expires_at: now + EXPIRES_SECONDS, wait_seconds: ready - now,
    empty: found.empty, blank: found.blank,
    device: identity,
    can_encrypt: !knob.mock,
    registered_drive_id: registered?.id ?? null,
    partitions: found.partitions, signatures: found.signatures,
    used_bytes: used.length ? used.reduce((a, b) => a + b, 0) : null,
  };
});

post("/api/v1/drive-format/start", ({ world, user, body }) => {
  requireAdmin(user, ADMIN_ONLY);
  const label = String(body.label ?? "").trim();
  if (!label || [...label].length > 80) return fail(400, "Give this drive a name between 1 and 80 characters.");
  const encrypted = body.password !== undefined && body.password !== null;
  if (encrypted) {
    const text = String(body.password);
    if (text.length < 12) return fail(400, "Passwords need at least 12 characters.", "weak_password");
    if (!/[a-zA-Z]/.test(text) || !/[0-9]/.test(text)) return fail(400, "Passwords need at least one letter and one number.", "weak_password");
  }
  const held = previews(world)[body.preview_id];
  if (!held) return fail(404, "Luna no longer has that preview. Look at the drive again.", "preview_not_found");
  const now = nowS();
  if (now >= held.expiresAt) return fail(410, "That preview is too old. Look at the drive again.", "preview_expired");
  if (now < held.readyAt) {
    return fail(409, "Wait for the countdown to finish, then try again.", "format_not_ready", { ready_at: held.readyAt, now });
  }
  const knob = detectedOn(world, held.device) ?? {};
  if (knob.mock && encrypted) return fail(400, "Directory mock drives can't be encrypted.", "mock_encryption");
  if (knob.missingTool) return fail(503, "Luna can't prepare drives. This Luna is missing a program it needs (mkfs.exfat).", "missing_tool");
  if (knob.busy || activeRun(world, held.device)) return fail(409, BUSY, "drive_busy");
  if (knob.swappedAtStart) return fail(409, "This isn't the drive that was shown, or it changed. Look at the drive again.", "drive_changed");
  if (knob.filesAppearedAtStart || (registeredOn(world, held.device)?.id ?? null) !== held.registeredDrive) {
    return fail(409, "This drive was added or removed since the preview. Look at the drive again.", "preview_stale");
  }
  delete previews(world)[held.id];
  const id = nextId("fr");
  runs(world)[id] = {
    id, device: held.device, driveId: held.registeredDrive, label, encrypted, phases: phasesFor(encrypted),
    startedMs: Date.now(), startedAt: now, phaseMs: knob.formatPhaseMs ?? 1500,
    failAt: knob.formatFailAt ?? null, failMessage: knob.formatFailMessage ?? "", settled: false,
    // Dev only: the drive row remembers the password so a scenario can lock and unlock it afterwards.
    password: encrypted ? String(body.password) : undefined,
  };
  return json(statusOf(world, runs(world)[id]), 202);
});

get("/api/v1/drive-format/:id", ({ world, user, params }) => {
  requireAdmin(user, ADMIN_ONLY);
  const run = runs(world)[params.id];
  if (!run) return fail(404, "Luna doesn't have a record of that erase. If Luna restarted, look at the drive again.", "format_not_found");
  return statusOf(world, run);
});

/** For scenarios: a run that started `agoMs` ago on `device`. Returns its id. */
export function seedRun(world, { device, driveId = null, label = "My drive", encrypted = false, agoMs = 0, phaseMs = 1500, failAt = null }) {
  const id = nextId("fr");
  runs(world)[id] = {
    id, device, driveId, label, encrypted, phases: phasesFor(encrypted), startedMs: Date.now() - agoMs,
    startedAt: nowS() - Math.floor(agoMs / 1000), phaseMs, failAt, failMessage: "", settled: false,
  };
  return id;
}

// Copy and move jobs, the way lunad's jobs.rs runs them:
//   - a job row is `running` from the moment it exists (there is no "queued"), and ends as
//     `done`, `error`, `cancelled` (or `interrupted`, when Luna restarts mid-job);
//   - a copy, or a move to ANOTHER drive, copies everything first and only then moves the
//     original to the drive's Trash; a move on the same drive is one rename that cannot fail
//     halfway;
//   - when a copy fails or is cancelled, the half-made copy at the destination is removed and
//     the original is untouched;
//   - only a finished job reports 100%; a failed or cancelled one keeps the progress it made, and its
//     error says what happened to the partial copy and the originals;
//   - a name that is already taken at the destination is refused when the job is made (409 exists),
//     unless the caller asks to keep both (the copy takes the next free name, "name (1).ext").
import { fail } from "./router.js";
import { nextId } from "./world.js";
import {
  CAP_EDIT, CAP_UPLOAD, CAP_VIEW, TRASH, hasCap, holdsUnreachablePrivate, isAdmin, isTrashPath, pathContains, privateBoundary,
} from "./policy.js";
import {
  base, clean, descendants, driveRow, driveUsable, ensureDirs, fsOf, fsOpts, join, moveToTrash, originalName, recordMove, trashEntry, uniqueName,
} from "./fsmodel.js";

const MAX_QUEUED_PER_USER = 4;
const UNKNOWN_DRIVE = "Luna doesn't know one of these drives. Make sure it's plugged in — if it already is, try unplugging it and plugging it back in.";
const BAD_PATH = "Luna can't use that path.";
const GENERIC = "Luna couldn't finish this job. Check the drives and try again.";
const REMOVED_PARTIAL_COPY = "Luna removed the partial copy.";
const NOTHING_MOVED = "Nothing was moved. Your files are still where they were.";

/** Would this carry an ordinary item out of its private folder (jobs.rs `broadens_access`)? */
export function broadensAccess(world, fromDrive, fromPath, toDrive, toPath) {
  let source = fromPath;
  let boundary;
  if (isTrashPath(fromPath)) {
    const { entry, sub } = trashEntry(fsOf(world, fromDrive), fromPath);
    if (!entry) return false;
    if (entry.nodes[sub]?.private) return false;
    boundary = entry.private_boundary || null;
  } else {
    if (fsOf(world, fromDrive).nodes[source]?.private) return false;
    boundary = privateBoundary(world, fromDrive, source);
  }
  if (!boundary) return false;
  const dst = privateBoundary(world, toDrive, toPath);
  if (!dst) return true;
  return fromDrive !== toDrive || dst.path !== boundary.path;
}

/** POST /api/v1/jobs — api/jobs.rs `create` and jobs.rs `prepare`. */
export function enqueueJob(world, user, body) {
  const kind = body.kind;
  const fromDrive = body.from_drive;
  const toDrive = body.to_drive;
  const rawFrom = String(body.from_path ?? "");
  const rawTo = String(body.to_path ?? "");
  if (/(^|\/)\.luna-[0-9a-f-]{6,}/.test(rawFrom) || /(^|\/)\.luna-[0-9a-f-]{6,}/.test(rawTo)) throw fail(400, BAD_PATH);
  const fromPath = clean(rawFrom);
  const toPath = clean(rawTo);
  const fromTrash = isTrashPath(fromPath);

  const need = kind === "move" || fromTrash ? CAP_EDIT : CAP_VIEW;
  if (!hasCap(world, user, fromDrive, fromPath, need)) throw fail(403, "You don't have permission to copy from here.");
  if (!hasCap(world, user, toDrive, toPath, CAP_UPLOAD)) throw fail(403, "You don't have permission to save here.");
  if (!body.confirm_broaden && broadensAccess(world, fromDrive, fromPath, toDrive, toPath)) {
    throw fail(409, "This is in a private folder. Moving or copying it to this folder lets everyone with access to the destination open it.", "broadens_access");
  }

  // JobManager::enqueue
  if (kind !== "copy" && kind !== "move") throw fail(400, "Luna only knows how to copy or move.");
  const mine = world.jobs.filter((j) => j.state === "running" && j.user_id === user.id).length;
  if (mine >= MAX_QUEUED_PER_USER) throw fail(503, "Luna is already working on a lot of copies and moves. Try again when they finish.", "queue_full");
  if (!driveUsable(world, fromDrive) || !driveUsable(world, toDrive)) throw fail(404, UNKNOWN_DRIVE);
  const from = fsOf(world, fromDrive);
  const to = fsOf(world, toDrive);

  let source;
  let name;
  let trashEntryRow = null;
  if (fromTrash) {
    if (fromPath === TRASH) throw fail(400, BAD_PATH);
    const found = trashEntry(from, fromPath);
    if (!found.entry) throw fail(400, BAD_PATH);
    trashEntryRow = found;
    source = found.entry.nodes[found.sub];
    name = found.sub ? base(found.sub) : originalName(found.entry.key);
  } else {
    if (!fromPath) throw fail(400, BAD_PATH);
    source = from.nodes[fromPath];
    name = base(fromPath);
  }
  if (!source) throw fail(400, BAD_PATH);
  if (isTrashPath(toPath)) throw fail(400, BAD_PATH);
  if (fromDrive === toDrive && !fromTrash && pathContains(fromPath, toPath)) throw fail(400, BAD_PATH);
  if (toPath && to.nodes[toPath]?.kind !== "dir") throw fail(400, BAD_PATH);
  let destRoot = join(toPath, name);
  if (to.nodes[destRoot]) {
    if (body.on_conflict !== "keep_both") {
      throw fail(409, "A file or folder with this name is already there. Choose a different destination.", "exists", { existing_kind: to.nodes[destRoot].kind === "dir" ? "dir" : "file" });
    }
    if (source.private) throw fail(409, "Luna can't keep two private items with the same name here. Choose Skip, or rename one first.", "keep_both_unsupported");
    name = uniqueName(to, toPath, name);
    destRoot = join(toPath, name);
  }
  if (kind === "move" && !fromTrash && holdsUnreachablePrivate(world, user, fromDrive, fromPath)) {
    throw fail(403, "This folder holds private items that only their owners can move.");
  }

  // The nodes to copy: [relative path, node]
  const items = fromTrash
    ? Object.entries(trashEntryRow.entry.nodes).filter(([rel]) => (trashEntryRow.sub ? pathContains(trashEntryRow.sub, rel) : true))
      .map(([rel, node]) => [trashEntryRow.sub ? rel.slice(trashEntryRow.sub.length + 1) : rel, node])
    : descendants(from, fromPath).sort().map((p) => [p === fromPath ? "" : p.slice(fromPath.length + 1), from.nodes[p]]);
  const total = items.reduce((t, [, n]) => t + (n.kind === "file" ? n.size || 0 : 0), 0);

  const o = fsOpts(world);
  const sameDriveMove = kind === "move" && fromDrive === toDrive && !fromTrash;
  const dest = driveRow(world, toDrive);
  const free = world.summaries[toDrive]?.free_bytes;
  // A drive that fills up stops the copy where it fills.
  const fillsAt = !sameDriveMove && free != null && total > free ? free / total : null;
  const job = {
    id: nextId("j"), kind, state: "running", user_id: user.id,
    from_drive: fromDrive, from_path: fromPath, to_drive: toDrive, to_path: toPath,
    progress: 0, total, error: "",
    _t0: Date.now(), _ms: o.jobMs, _items: items.map(([rel, node]) => [rel, { ...node }]),
    _dest: destRoot, _copied: 0, _same: sameDriveMove, _name: name,
    _failAt: o.jobFailAt ?? fillsAt,
    _failMessage: o.jobFailMessage || (o.jobFailAt == null && fillsAt != null ? `${dest?.label || "The destination drive"} is full. Free up some space on it and try again.` : ""),
    _destReadonly: dest?.state === "readonly",
  };
  world.jobs.push(job);
  return { id: job.id, kind: job.kind, state: job.state, progress: job.progress, total: job.total };
}

function removeDest(world, job) {
  const to = fsOf(world, job.to_drive);
  for (const k of descendants(to, job._dest)) delete to.nodes[k];
}

function end(job, state, error = "") {
  job.state = state;
  job.error = error;
  if (state === "done") job.progress = job.total; // only a finished job reports 100%
}

/** What a failed job says about the half-made copy and the originals. */
const withAftermath = (job, message) => (job._owned ? `${message} ${job.kind === "move" ? NOTHING_MOVED : REMOVED_PARTIAL_COPY}` : message);

function copyUpTo(world, user, job, count) {
  const to = fsOf(world, job.to_drive);
  ensureDirs(to, job.to_path);
  while (job._copied < count) {
    const [rel, node] = job._items[job._copied];
    const target = rel ? join(job._dest, rel) : job._dest;
    to.nodes[target] = { ...node, ...(node.private && job.kind === "copy" ? { owner: job.user_id } : {}) };
    job._copied += 1;
  }
  void user;
}

/** Advances every running job by the time that has passed. */
export function tickJobs(world) {
  const t = Date.now();
  for (const job of world.jobs) {
    if (job.state !== "running") continue;
    const from = fsOf(world, job.from_drive);
    const to = fsOf(world, job.to_drive);
    if (job._destReadonly) { end(job, "error", GENERIC); continue; }
    if (job._same) {
      // One rename: it cannot stop halfway.
      if (!from.nodes[job.from_path]) { end(job, "error", "A file disappeared while Luna was copying it."); continue; }
      if (to.nodes[job._dest]) { end(job, "error", "A file or folder with this name is already there."); continue; }
      for (const [rel] of job._items) {
        const src = rel ? join(job.from_path, rel) : job.from_path;
        to.nodes[rel ? join(job._dest, rel) : job._dest] = from.nodes[src];
        delete from.nodes[src];
      }
      recordMove(world, job.from_drive, job.from_path, job.to_drive, job._dest);
      end(job, "done");
      continue;
    }
    job._owned = true; // the destination exists from here on
    const p = Math.min(1, (t - job._t0) / Math.max(job._ms, 1));
    const reached = job._failAt != null ? Math.min(p, job._failAt) : p;
    copyUpTo(world, null, job, Math.floor(job._items.length * reached));
    job.progress = Math.round(job.total * reached);
    if (job._failAt != null && p >= job._failAt) {
      removeDest(world, job); // the half-made copy goes; the original is untouched
      end(job, "error", withAftermath(job, job._failMessage || GENERIC));
    } else if (p >= 1) {
      copyUpTo(world, null, job, job._items.length);
      if (job.kind === "move") {
        recordMove(world, job.from_drive, job.from_path, job.to_drive, job._dest);
        if (isTrashPath(job.from_path)) {
          const { entry } = trashEntry(from, job.from_path);
          if (entry) from.trash = from.trash.filter((x) => x !== entry);
        } else if (from.nodes[job.from_path]) {
          moveToTrash(world, job.from_drive, job.from_path);
        }
      }
      end(job, "done");
    }
  }
}

/** api/jobs.rs `job_json`: paths and details of other people's private jobs are blanked. */
export function jobJson(world, job, viewer) {
  const hidden = (drive, path) => job.user_id !== viewer.id && (Boolean(privateBoundary(world, drive, path)) || /\.luna-[0-9a-f-]{6,}/.test(path));
  const fromHidden = hidden(job.from_drive, job.from_path);
  const toHidden = hidden(job.to_drive, job.to_path);
  const redacted = fromHidden || toHidden;
  return {
    id: job.id, kind: job.kind, state: job.state, user_id: job.user_id,
    from_drive: job.from_drive, from_path: fromHidden ? "private" : job.from_path,
    to_drive: job.to_drive, to_path: toHidden ? "private" : job.to_path,
    progress: redacted ? 0 : job.progress, total: redacted ? 0 : job.total, error: redacted ? "" : job.error,
  };
}

export function visibleJobs(world, user) {
  return world.jobs.filter((j) => isAdmin(user) || j.user_id === user.id);
}

export function findJob(world, user, id) {
  const job = world.jobs.find((j) => j.id === id);
  if (!job || !(isAdmin(user) || job.user_id === user.id)) throw fail(404, "Luna doesn't know this job.");
  return job;
}

/** DELETE /api/v1/jobs/:id — flags the job; a copy still running is stopped and cleaned up. */
export function cancelJob(world, job) {
  if (job.state !== "running") return;
  const copied = Boolean(job._owned);
  if (!job._same) removeDest(world, job);
  end(job, "cancelled", copied && job.kind === "copy" ? REMOVED_PARTIAL_COPY : "");
}

/** Luna restarted while jobs were running. */
export function interruptJobs(world) {
  for (const job of world.jobs) if (job.state === "running") { removeDest(world, job); end(job, "interrupted", "Luna restarted while this job was running."); }
}


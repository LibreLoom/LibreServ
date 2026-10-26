// How the contract test calls each fake route. Keys are the fake's own patterns ("GET /api/v1/drives/:id/summary").
// `url(world)` builds the request from what a world holds (look things up by property, never by position,
// so seed changes don't break it) and returns null when this world has nothing suitable.
// `{ skip }` marks answers that are file bytes in lunad, so there is no JSON shape to compare.
import { fsOf } from "../fake/handlers/files.js";

/**
 * @typedef {{
 *   url: (world: any) => string | null,
 *   body?: (world: any) => object,
 *   prepare?: (world: any) => void,
 * } | { skip: string }} Case
 */

const q = encodeURIComponent;

/** A drive that is plugged in and readable. */
const driveId = (w) => (w.drives || []).find((d) => d?.id && w.summaries?.[d.id]?.mounted !== false)?.id ?? null;
const backupOnDrive = (w) => (w.backups || []).find((b) => b?.id && b.target_drive) ?? null;
const shareLinks = (w) => (w.sharing?.subjects || []).flatMap((s) => s.links || []);
/** A link anyone can open: not turned off, no password, not expired. */
const openLink = (w) => shareLinks(w).find((l) => l?.token && !l.disabled && !l.password && !l.expires_at) ?? null;

/** @param {(w: any, id: string) => string} build */
const onDrive = (build) => ({ url: (w) => { const d = driveId(w); return d ? build(w, d) : null; } });
/** @param {string} path */
const plain = (path) => ({ url: () => path });

/** @type {Record<string, Case>} */
export const CASES = {
  // Sign-in and setup
  "GET /api/v1/auth/me": plain("/api/v1/auth/me"),
  "GET /api/v1/auth/status": plain("/api/v1/auth/status"),
  "GET /api/v1/setup": plain("/api/v1/setup"),
  "GET /api/v1/setup/preflight": plain("/api/v1/setup/preflight"),
  "GET /api/v1/users": plain("/api/v1/users"),
  "GET /api/v1/users/directory": plain("/api/v1/users/directory"),
  "GET /api/v1/users/:id/private-count": { url: (w) => { const u = (w.users || []).find((x) => x?.id); return u ? `/api/v1/users/${q(u.id)}/private-count` : null; } },

  // Drives
  "GET /api/v1/drives": plain("/api/v1/drives"),
  "GET /api/v1/drives/detected": plain("/api/v1/drives/detected"),
  "GET /api/v1/drives/:id/summary": onDrive((w, d) => `/api/v1/drives/${q(d)}/summary`),
  "GET /api/v1/drives/:id/health": onDrive((w, d) => `/api/v1/drives/${q(d)}/health`),
  // The app sends POST (FilesPage.jsx); lunad only has POST. The GET case checks the method.
  "GET /api/v1/drives/:name/inspect": { url: (w) => { const dev = (w.drives || []).find((d) => d?.device)?.device; return dev ? `/api/v1/drives/${q(dev)}/inspect` : null; } },
  "POST /api/v1/drives/:name/inspect": { url: (w) => { const dev = (w.drives || []).find((d) => d?.device)?.device; return dev ? `/api/v1/drives/${q(dev)}/inspect` : null; }, body: () => ({}) },

  // System
  "GET /api/v1/system/health/check": plain("/api/v1/system/health/check"),
  "GET /api/v1/system/updates": plain("/api/v1/system/updates"),
  "GET /api/v1/system/updates/source": plain("/api/v1/system/updates/source"),
  "GET /api/v1/network/status": plain("/api/v1/network/status"),
  "GET /api/v1/connect/status": plain("/api/v1/connect/status"),
  "GET /api/v1/me/recents": plain("/api/v1/me/recents"),

  // Files
  "GET /api/v1/drives/:id/files": onDrive((w, d) => `/api/v1/drives/${q(d)}/files?path=`),
  "GET /api/v1/drives/:id/files/stat": onDrive((w, d) => `/api/v1/drives/${q(d)}/files/stat?path=`),
  "GET /api/v1/drives/:id/files/resolve": {
    // Needs a remembered move; the fake only has one after something was renamed.
    prepare: (w) => { const d = driveId(w); if (d) { const fs = fsOf(w, d); fs.moved = { ...fs.moved, "old-name.txt": "Documents" }; } },
    url: (w) => { const d = driveId(w); return d ? `/api/v1/drives/${q(d)}/files/resolve?path=${q("old-name.txt")}` : null; },
  },
  "GET /api/v1/drives/:id/files/content": { skip: "file bytes, not JSON" },
  "GET /api/v1/search": plain("/api/v1/search?q=notes"),

  // Jobs
  "GET /api/v1/jobs": plain("/api/v1/jobs"),
  "GET /api/v1/jobs/:id": { url: (w) => { const j = (w.jobs || []).find((x) => x?.id); return j ? `/api/v1/jobs/${q(j.id)}` : null; } },

  // Backups
  "GET /api/v1/backups": plain("/api/v1/backups"),
  "GET /api/v1/backups/covered": onDrive((w, d) => `/api/v1/backups/covered?drive=${q(d)}&path=${q("Documents")}`),
  "GET /api/v1/drives/:id/backups": { url: (w) => { const b = backupOnDrive(w); return b ? `/api/v1/drives/${q(b.target_drive)}/backups` : null; } },
  "GET /api/v1/drives/:id/backups/:bid/list": { url: (w) => { const b = backupOnDrive(w); return b ? `/api/v1/drives/${q(b.target_drive)}/backups/${q(b.id)}/list?path=` : null; } },
  "GET /api/v1/drives/:id/backups/:bid/versions": { url: (w) => { const b = backupOnDrive(w); return b ? `/api/v1/drives/${q(b.target_drive)}/backups/${q(b.id)}/versions?path=${q("notes.txt")}` : null; } },
  "GET /api/v1/drives/:id/backups/:bid/download": { skip: "file bytes, not JSON" },
  "GET /api/v1/cloud/backups": plain("/api/v1/cloud/backups"),
  "GET /api/v1/cloud/phrase": plain("/api/v1/cloud/phrase"),
  "GET /api/v1/cloud/phrase/scopes": plain("/api/v1/cloud/phrase/scopes"),
  "GET /api/v1/cloud/restore": plain("/api/v1/cloud/restore"),
  "GET /api/v1/cloud/restore/records/:kind": plain("/api/v1/cloud/restore/records/backup"),
  "GET /api/v1/cloud/restore-private": plain("/api/v1/cloud/restore-private"),
  "GET /api/v1/cloud/restore-private/records/:kind": plain("/api/v1/cloud/restore-private/records/pscopes"),
  "GET /api/v1/cloud/restore-private/records/:kind/names": plain("/api/v1/cloud/restore-private/records/psnapshots/names"),
  "GET /api/v1/cloud/restore-private/records/:kind/:name": plain("/api/v1/cloud/restore-private/records/psnapshots/snapshot-1"),

  // Private folders
  "GET /api/v1/private-backups/summary": plain("/api/v1/private-backups/summary"),
  "GET /api/v1/private-backups/mine": plain("/api/v1/private-backups/mine"),
  "GET /api/v1/private-backups/item": onDrive((w, d) => `/api/v1/private-backups/item?drive=${q(d)}&path=${q("Documents")}`),
  "GET /api/v1/private/orphans": plain("/api/v1/private/orphans"),
  "GET /api/v1/private/ownerless": plain("/api/v1/private/ownerless"),

  // Access tokens
  "GET /api/v1/device-tokens": plain("/api/v1/device-tokens"),
  "GET /api/v1/device-tokens/:id/usage": { url: (w) => { const t = (w.tokens || []).find((x) => x?.id); return t ? `/api/v1/device-tokens/${q(t.id)}/usage` : null; } },

  // Sharing and forms
  "GET /api/v1/access/subject": onDrive((w, d) => `/api/v1/access/subject?kind=path&drive_id=${q(d)}&path=${q("Documents")}`),
  "GET /api/v1/access/mine": plain("/api/v1/access/mine"),
  "GET /api/v1/me/access": plain("/api/v1/me/access"),
  "GET /api/v1/forms/responses": onDrive((w, d) => `/api/v1/forms/responses?drive_id=${q(d)}&path=${q("Documents/form.lform")}`),
  "GET /api/v1/forms/file": { skip: "file bytes in lunad, not JSON" },
  "GET /s/:token": { url: (w) => { const l = openLink(w); return l ? `/s/${q(l.token)}` : null; } },
  "GET /s/:token/items": { url: (w) => { const l = openLink(w); return l ? `/s/${q(l.token)}/items` : null; } },
  "GET /s/:token/list": { url: (w) => { const l = openLink(w); return l ? `/s/${q(l.token)}/list` : null; } },
  "GET /s/:token/stat": { url: (w) => { const l = openLink(w); return l ? `/s/${q(l.token)}/stat` : null; } },
  "GET /s/:token/respond": {
    url: (w) => {
      const l = shareLinks(w).find((x) => x?.token && !x.password && x.responses?.some((r) => r.edit_token));
      return l ? `/s/${q(l.token)}/respond?edit_token=${q(l.responses.find((r) => r.edit_token).edit_token)}` : null;
    },
  },
  "GET /s/:token/form-image": { skip: "image bytes, not JSON" },
  "GET /s/:token/file": { skip: "file bytes, not JSON" },

  // Photos
  "GET /api/v1/gallery": plain("/api/v1/gallery"),
  "GET /api/v1/gallery/albums": plain("/api/v1/gallery/albums"),
  "GET /api/v1/gallery/places": plain("/api/v1/gallery/places"),
  "GET /api/v1/gallery/status": plain("/api/v1/gallery/status"),
  "GET /api/v1/gallery/cameras": plain("/api/v1/gallery/cameras"),
  "GET /api/v1/gallery/filter-facets": plain("/api/v1/gallery/filter-facets"),
  "GET /api/v1/gallery/duplicates": plain("/api/v1/gallery/duplicates"),
  "GET /api/v1/gallery/preview": { skip: "image bytes, not JSON" },
};


// The drive's backups as a file source, so the file browser lists them the way it lists Trash.
import { getJson } from "../../lib/api.js";
import { driveSource } from "../../lib/fileSource.jsx";
import { BACKUPS_PATH } from "../../lib/paths.js";

export const base = (driveId, backupId) => `/api/v1/drives/${driveId}/backups/${backupId}`;

export function downloadUrl(driveId, backupId, relPath, at) {
  const atPart = at ? `&at=${encodeURIComponent(at)}` : "";
  return `${base(driveId, backupId)}/download?path=${encodeURIComponent(relPath)}${atPart}`;
}

/** "<backup id>/<folder inside it>" → the two parts. The empty path is the list of backups. */
export function splitBackupPath(path) {
  const slash = path.indexOf("/");
  return slash < 0 ? { id: path, sub: "" } : { id: path.slice(0, slash), sub: path.slice(slash + 1) };
}

/**
 * The drive's backups, shaped as a file source so the normal file browser shows them the way
 * it shows Trash: the root lists the backups as folders, deeper paths are the files kept in one.
 */
export function backupSource(driveId) {
  return {
    ...driveSource,
    guest: false,
    collab: false,
    async listDir(_drive, path) {
      const inner = path === BACKUPS_PATH ? "" : path.slice(BACKUPS_PATH.length + 1);
      if (!inner) {
        const list = await getJson(`/api/v1/drives/${driveId}/backups`);
        return (Array.isArray(list) ? list : []).map((b) => ({
          name: b.id,
          original_name: b.source_name,
          kind: "dir",
          size: b.size_bytes,
          modified: b.last_ok_at,
          hidden: false,
          backup: b,
        }));
      }
      const { id, sub } = splitBackupPath(inner);
      const [backups, list] = await Promise.all([
        getJson(`/api/v1/drives/${driveId}/backups`).then((r) => (Array.isArray(r) ? r : [])),
        getJson(`${base(driveId, id)}/list?path=${encodeURIComponent(sub)}`),
      ]);
      return (Array.isArray(list) ? list : []).map((e) => ({
        name: e.name,
        original_name: e.deleted ? `${e.name} (deleted)` : e.name,
        kind: e.is_dir ? "dir" : "file",
        size: e.size,
        hidden: false,
        deleted: e.deleted,
        deleted_at: e.deleted_at,
        modified: e.mtime ?? undefined,
        backup: backups.find((b) => b.id === id),
      }));
    },
    stat: async () => ({ kind: "dir" }),
    downloadHref(_drive, path) {
      const { id, sub } = splitBackupPath(path.slice(BACKUPS_PATH.length + 1));
      return downloadUrl(driveId, id, sub);
    },
  };
}

/** Crumb labels for `.luna-backups/<id>/...`: "Backups", the backup's source folder, then real names. */
export function backupSegmentLabel(backups, path) {
  const { id } = splitBackupPath(path.slice(BACKUPS_PATH.length + 1));
  const name = backups.find((b) => b.id === id)?.source_name;
  return (segment, index) => (index === 0 ? "Backups" : index === 1 && name ? name : segment);
}

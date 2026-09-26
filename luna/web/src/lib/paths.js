/** Public API alias for a drive's trash folder — browses like a real path. */
export const TRASH_PATH = ".luna-trash";

/** `.luna-<uuid>-members` — the per-drive container holding every member home. */
const MEMBERS_SEG_RE =
  /^\.luna-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-members$/;

/**
 * `path` addresses inside a member home — `.luna-<uuid>-members/<username>/…`.
 * Such paths are hidden from every listing except the owner's, and the UI
 * shows the owner segment as "Home" rather than the raw username.
 */
export function isMemberHomePath(path) {
  const segs = String(path || "").split("/");
  return segs.length >= 2 && segs[1] !== "" && MEMBERS_SEG_RE.test(segs[0]);
}

/** `path` is exactly a member-home root — not deletable, not renameable. */
export function isHomeRootPath(path) {
  return isMemberHomePath(path) && String(path || "").split("/").length === 2;
}

/** The username a member-home path belongs to — segment 1 of the rel. */
export function memberHomeOwner(path) {
  if (!isMemberHomePath(path)) return null;
  return String(path).split("/")[1] || null;
}

/**
 * Privacy-safe display label for a path that may sit inside a member home.
 * The internal `.luna-<uuid>-members/<name>` prefix never reaches the UI:
 * the viewer's own home collapses to "Home", a peer's to "<name>'s home",
 * and deeper segments trail after it ("Home / docs").
 *
 * @param path        raw rel path (may be inside a member home)
 * @param ownHomePath the viewer's own home rel, from `/me` — may be null
 */
export function homeAwareLabel(path, ownHomePath = "") {
  const raw = String(path || "");
  if (!isMemberHomePath(raw)) return raw;
  const segs = raw.split("/");
  const root = segs.slice(0, 2).join("/");
  const owner = segs[1];
  const label = ownHomePath && root === ownHomePath
    ? "Home"
    : `${owner}'s home`;
  const rest = segs.slice(2).join("/");
  return rest ? `${label} / ${rest}` : label;
}

/** Display label for a path segment (member homes read "Home"). */
export function segmentDisplayName(segment, index = 0, fullPath = "") {
  // Index 1 is the username inside `.luna-<uuid>-members/<username>` — the
  // segment the UI relabels as the member's private home.
  if (index === 1 && isMemberHomePath(fullPath || segment)) return "Home";
  return segment;
}

/** Is `path` the trash folder itself or somewhere inside it? */
export function isTrashPath(path) {
  return path === TRASH_PATH || path.startsWith(`${TRASH_PATH}/`);
}

/**
 * Display name for a `.luna-trash/...` path. Top-level entries carry a
 * generated `{nonce}-` (or `{nonce}-{n}-`) prefix on disk that must never
 * reach the UI; deeper paths already carry real names.
 */
export function trashDisplayName(path) {
  const base = pathBasename(path);
  const match = base.match(/^\d+-(\d+-)?(.+)$/);
  return match ? match[2] : base;
}

/** Join a relative drive path with a child name. */
export function joinPath(base, name) {
  return base ? `${base}/${name}` : name;
}

/** Parent of a relative path, or null at the drive root. */
export function parentPath(path) {
  if (!path) return null;
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

/** Router href for a folder on a drive. */
export function folderHref(driveId, folderPath) {
  if (!folderPath) return `/drives/${driveId}`;
  return `/drives/${driveId}?path=${encodeURIComponent(folderPath)}`;
}

/** Router href for opening a file in its folder on a drive. */
export function fileHref(driveId, filePath) {
  const folder = parentPath(filePath) ?? "";
  const name = pathBasename(filePath);
  const base = folderHref(driveId, folder);
  if (!name) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}file=${encodeURIComponent(name)}`;
}

/**
 * Router href for a search hit: folders open into themselves; files open the
 * parent folder and deep-link a `select=` path so the browser can highlight
 * and scroll to the file.
 *
 * @param {{
 *   drive_id: string,
 *   path: string,
 *   kind?: string,
 *   parent?: string | null,
 * }} item
 */
export function searchResultHref(item) {
  if (item.kind === "dir") {
    return folderHref(item.drive_id, item.path || "");
  }
  const folder = item.parent != null ? item.parent : (parentPath(item.path) ?? "");
  const base = folderHref(item.drive_id, folder);
  if (!item.path) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}select=${encodeURIComponent(item.path)}`;
}

/** Human-readable size (decimal). */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(1)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(1)} GB`;
}

/** Download URL for a file or folder on a drive (folders arrive as a zip). */
export function downloadHref(driveId, filePath) {
  return `/api/v1/drives/${driveId}/files/content?path=${encodeURIComponent(filePath)}&download=1`;
}

/** Inline content URL (images, video, plain text). Luna forces download for unsafe types. */
export function contentHref(driveId, filePath) {
  return `/api/v1/drives/${driveId}/files/content?path=${encodeURIComponent(filePath)}`;
}

/** Last segment of a relative path. */
export function pathBasename(path) {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

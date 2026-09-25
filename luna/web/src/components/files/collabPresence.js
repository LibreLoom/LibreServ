/**
 * Presence line shared by EuroOffice and the diagram editor.
 * FileViewer renders it in the fullscreen chrome so both editors read
 * the same way: who else is here, and whether this session can edit.
 *
 * @param {"loading"|"ready"|"error"} status
 * @param {{ peer_id: number, username: string }[]} peers
 * @param {boolean} canWrite
 * @param {string} [selfName]
 * @param {number | null} [selfPeerId]
 * @param {string} [loadingLabel]
 */
export function collabPresenceLabel(
  status,
  peers,
  canWrite,
  selfName = "",
  selfPeerId = null,
  loadingLabel = "Starting EuroOffice…",
) {
  if (status === "error") return "";
  const self = String(selfName || "").toLowerCase();
  const others = (peers || [])
    .filter((p) =>
      selfPeerId != null
        ? p.peer_id !== selfPeerId
        : p.username && p.username.toLowerCase() !== self,
    )
    .map((p) => p.username)
    .filter(Boolean);
  let base =
    status === "loading"
      ? loadingLabel
      : others.length
        ? `Live · ${others.join(", ")}`
        : "Live · only you";
  if (!canWrite) base = `${base} · view only`;
  return base;
}

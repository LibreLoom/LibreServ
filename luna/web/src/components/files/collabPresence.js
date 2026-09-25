/**
 * Presence line shared by EuroOffice and the diagram editor.
 * Both editors report the same string (who else is here, and whether
 * this session can edit). The fullscreen frame does not draw it yet.
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

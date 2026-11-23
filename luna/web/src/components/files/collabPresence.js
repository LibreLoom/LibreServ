/**
 * Presence line shared by EuroOffice, the diagram editor and the whiteboard.
 * Both editors report the same string (who else is here, and whether this
 * session can edit); FullscreenEditorFrame draws it in the rail/topbar.
 *
 * `COLLAB_OFFLINE_PREFIX` lets the frame recognise an offline line so it can
 * also show the message as a banner, not just a tiny status dot.
 */
export const COLLAB_OFFLINE_PREFIX = "Live editing isn't connected";

/**
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
  // No hub (a solo session, or one that gave up reconnecting) is NOT "live".
  // Editing still works and saves to this Luna; say that instead of painting
  // a rosy "Live · only you" over a dead socket.
  if (status === "error") {
    return canWrite
      ? `${COLLAB_OFFLINE_PREFIX}. Changes still save to this Luna.`
      : `${COLLAB_OFFLINE_PREFIX} · view only`;
  }

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

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
 * Is this the honest "live editing isn't connected" notice, and so worth a
 * banner in the frame? Status lines for a failed open are empty, so this is
 * the one place that decides which presence lines deserve a banner.
 * @param {string | null | undefined} presence
 */
export function isCollabOfflinePresence(presence) {
  return typeof presence === "string" && presence.startsWith(COLLAB_OFFLINE_PREFIX);
}

/**
 * @param {"loading"|"ready"|"collab-offline"|"error"} status
 *   `error` means the editor itself failed to open (bad file type, start
 *   timeout, crash) — its error card says what happened, so no presence line.
 *   `collab-offline` is a real hub loss after the editor did open: editing
 *   alone still works and saves to this Luna.
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
  // No hub and the editor never opened: the error card owns this moment. A
  // "changes still save" line here would claim the opposite of that card.
  if (status === "error") return "";

  // A real collab disconnect (or a solo room the hub never answered) is NOT
  // "live". Editing still works and saves to this Luna; say that instead of
  // painting a rosy "Live · only you" over a dead socket.
  if (status === "collab-offline") {
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

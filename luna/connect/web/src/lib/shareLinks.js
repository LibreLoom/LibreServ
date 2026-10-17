import { api } from "../api.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Make a link to one person's backups ("user") or to one backup ("backup").
 * POST /api/v1/cloud/share-links → { id, token, expires_at }.
 * @param {string} lunaId
 * @param {{ kind: "user" | "backup", value: string }} scope
 */
export function createShareLink(lunaId, scope) {
  return api("/api/v1/cloud/share-links", {
    method: "POST",
    body: JSON.stringify({ luna_id: lunaId, scope_kind: scope.kind, scope_value: scope.value }),
  });
}

/** GET /api/v1/cloud/share-links → links array (active only). */
export async function listShareLinks() {
  const data = await api("/api/v1/cloud/share-links");
  return data.links || [];
}

/** DELETE /api/v1/cloud/share-links/{id}. */
export function revokeShareLink(id) {
  return api(`/api/v1/cloud/share-links/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** `${origin}/share#${token}`. The token goes in the part after #, which browsers never send to a server. */
export function shareUrl(token, origin = window.location.origin) {
  return `${origin}/share#${token}`;
}

/** Read and check the token from location.hash: 43 chars of [A-Za-z0-9_-], else "". */
export function tokenFromHash(hash) {
  const token = String(hash || "").replace(/^#/, "");
  return TOKEN_PATTERN.test(token) ? token : "";
}

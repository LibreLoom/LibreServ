/** Normalize Luna's Connect status for UI state without inferring it from local files. */
export function connectState(status) {
  if (!status) return "loading";
  if (status.state === "revoked" || status.revoked) return "revoked";
  if (status.unbind_pending) return "pending";
  if (status.state === "pending") return "pending";
  if (status.state === "pairing") return "pairing";
  if (status.state === "bound") return "bound";
  if (status.state === "unbound") return "unbound";
  return status.paired ? "bound" : "unbound";
}

export function isConnectBound(status) {
  return connectState(status) === "bound" && status?.connect_active !== false;
}

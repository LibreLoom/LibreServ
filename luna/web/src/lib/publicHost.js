/** True when this tab is on Luna's public internet name, not luna.local / LAN. */
export function isPublicLunaHost(hostname) {
  const host = String(hostname ?? (typeof window !== "undefined" ? window.location.hostname : ""))
    .toLowerCase()
    .split(":")[0];
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  if (host === "luna.local" || host.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

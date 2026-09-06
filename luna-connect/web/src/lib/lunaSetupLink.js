/**
 * Build the Luna setup link shown at the end of Connect onboarding.
 * Display is hostname-only (no /setup, no query); href still opens /setup
 * and includes ?token= when available.
 *
 * @param {string} hostname Public hostname or absolute URL for the Luna
 * @param {string} [deviceToken] Full device token to embed for silent WAN auth
 * @returns {{ display: string, href: string }}
 */
export function buildLunaSetupLink(hostname, deviceToken = "") {
  const raw = String(hostname || "").trim();
  if (!raw) return { display: "", href: "" };

  const base = raw.startsWith("http://") || raw.startsWith("https://")
    ? raw.replace(/\/+$/, "")
    : `https://${raw.replace(/\/+$/, "")}`;

  let setupUrl = `${base}/setup`;
  try {
    const u = new URL(base);
    if (u.pathname.replace(/\/+$/, "") === "/setup") {
      setupUrl = base;
    } else {
      u.pathname = "/setup";
      u.search = "";
      u.hash = "";
      setupUrl = u.toString().replace(/\/+$/, "");
    }
  } catch {
    /* keep setupUrl from string concat */
  }

  // Visible label: hostname only — hide /setup so the pill doesn't wrap mid-path.
  const display = raw
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\/setup$/i, "");

  const token = String(deviceToken || "").trim();
  const href = token
    ? `${setupUrl}?token=${encodeURIComponent(token)}`
    : setupUrl;

  return { display, href };
}

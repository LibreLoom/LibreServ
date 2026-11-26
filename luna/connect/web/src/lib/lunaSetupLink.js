export const SETUP_TOKEN_FRAGMENT = "token";

/**
 * Build the Luna setup link shown at the end of Connect onboarding.
 * Display is hostname-only. The device token goes in the URL fragment (never
 * the query string) so it is never sent to a web server.
 *
 * @param {string} hostname Public hostname or absolute URL for the Luna
 * @param {string} [deviceToken] Device token that prefills off-LAN first-Admin setup
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
      u.search = "";
      u.hash = "";
      setupUrl = u.toString().replace(/\/+$/, "");
    } else {
      u.pathname = "/setup";
      u.search = "";
      u.hash = "";
      setupUrl = u.toString().replace(/\/+$/, "");
    }
  } catch {
    /* keep setupUrl from string concat */
  }

  let display = raw
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\/setup$/i, "");
  try {
    display = new URL(base).host;
  } catch {
    /* keep the string fallback for an incomplete hostname */
  }

  const token = String(deviceToken || "").trim();
  const href = token
    ? `${setupUrl}#${SETUP_TOKEN_FRAGMENT}=${encodeURIComponent(token)}`
    : setupUrl;

  return { display, href };
}

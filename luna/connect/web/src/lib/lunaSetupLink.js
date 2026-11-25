export const SETUP_GRANT_FRAGMENT = "setup_grant";

/**
 * Build the Luna setup link shown at the end of Connect onboarding.
 * Display is hostname-only. The one-time grant goes in the fragment so it is
 * never sent to a web server in the URL.
 *
 * @param {string} hostname Public hostname or absolute URL for the Luna
 * @param {string} [setupGrant] One-time grant for off-LAN first-Admin setup
 * @returns {{ display: string, href: string }}
 */
export function buildLunaSetupLink(hostname, setupGrant = "") {
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

  const grant = String(setupGrant || "").trim();
  const href = grant
    ? `${setupUrl}#${SETUP_GRANT_FRAGMENT}=${encodeURIComponent(grant)}`
    : setupUrl;

  return { display, href };
}

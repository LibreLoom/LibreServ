/**
 * Phone pairing payload. Luna web shows this as a QR code; the Android app
 * scans it (or opens a luna://pair link) and fills address + access token.
 */

/**
 * @param {string} url Luna address (e.g. http://luna.local)
 * @param {string} token Access token (shown once)
 * @returns {string}
 */
export function encodePairing(url, token) {
  const u = new URL("luna://pair");
  u.searchParams.set("url", trimUrl(url));
  u.searchParams.set("token", String(token || "").trim());
  return u.toString();
}

/**
 * @param {string | null | undefined} raw
 * @returns {{ url: string, token: string } | null}
 */
export function decodePairing(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      const url = trimUrl(obj.url);
      const token = String(obj.token || "").trim();
      if (url && token) return { url, token };
    } catch {
      return null;
    }
    return null;
  }
  try {
    const u = new URL(text);
    if (u.protocol !== "luna:") return null;
    const name = (u.hostname || u.pathname.replace(/^\//, "")).toLowerCase();
    if (name !== "pair") return null;
    const url = trimUrl(u.searchParams.get("url"));
    const token = (u.searchParams.get("token") || "").trim();
    if (!url || !token) return null;
    return { url, token };
  } catch {
    return null;
  }
}

/** @param {unknown} url */
function trimUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

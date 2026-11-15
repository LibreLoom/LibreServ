export function readCookie(name) {
  if (typeof document === "undefined" || !document.cookie) return "";
  const parts = document.cookie.split(";");
  for (const p of parts) {
    const [k, ...rest] = p.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

/** Shown when the request gets no answer at all. */
export const NO_ANSWER = "Could not reach Luna Connect. Check your internet connection, then try again.";

/**
 * The sentence for an error answer that carries none of its own. Connect always sends JSON, so a
 * bare or non-JSON error body comes from something in between (a proxy or a gateway page).
 * @param {number} status
 */
export function noSentence(status) {
  return status >= 500
    ? "Luna Connect is not working right now. Try again in a few minutes."
    : "Luna Connect did not accept this request. Reload the page, then try again.";
}

/**
 * fetch(), with a network failure turned into NO_ANSWER.
 * @param {string} path
 * @param {RequestInit} init
 */
export async function fetchOrExplain(path, init) {
  try {
    return await fetch(path, init);
  } catch {
    throw new Error(NO_ANSWER);
  }
}

export async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie("luna_connect_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  // Force credentials after opts so callers cannot drop cookies/CSRF.
  const res = await fetchOrExplain(path, {
    ...opts,
    credentials: "include",
    headers,
  });
  const text = await res.text();
  let data = {};
  let parsed = true;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    parsed = false;
    data = { message: text };
  }
  if (!res.ok) {
    const sentence = parsed ? data.message || data.error : "";
    const err = /** @type {Error & { status?: number, data?: any }} */ (
      new Error(sentence || noSentence(res.status))
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}


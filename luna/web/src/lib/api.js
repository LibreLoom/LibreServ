// Minimal Luna API client. One function per endpoint keeps the bundle small
// and makes the server contract explicit.
//
// Cookie-authenticated mutations MUST go through these helpers so
// X-CSRF-Token is attached. Raw `fetch` skips CSRF and lunad answers 403
// ("This page expired.") — or, with the Vite proxy rewriting Host, the
// Origin guard returns "Cross-site request blocked."

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

function isNetworkFailureMessage(raw) {
  return /networkerror|failed to fetch|load failed|network request failed|fetch failed|aborted|econnrefused|econnreset/i.test(
    String(raw || ""),
  );
}

/** Attach credentials + CSRF for cookie-authenticated mutations. */
export function withCsrfHeaders(method, headers = {}) {
  const merged = { ...headers };
  const upper = (method || "GET").toUpperCase();
  if (upper !== "GET" && upper !== "HEAD") {
    const csrf = readCookie("luna_csrf");
    if (csrf) merged["X-CSRF-Token"] = csrf;
  }
  return merged;
}

/**
 * Low-level fetch for callers that need a raw Response. Always includes
 * credentials and attaches X-CSRF-Token on mutating methods.
 */
export async function apiFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = withCsrfHeaders(method, options.headers || {});
  try {
    // Spread options first, then force credentials + merged headers so a
    // caller's Content-Type object cannot wipe X-CSRF-Token.
    return await fetch(path, {
      ...options,
      credentials: "include",
      headers,
    });
  } catch (err) {
    throw new ApiError(
      0,
      apiErrorMessage(err, "Couldn't reach Luna. Check this device's connection and try again."),
    );
  }
}

export async function getJson(path, options = {}) {
  return request(path, options);
}

export async function postJson(path, body, options = {}) {
  return request(path, {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(body),
  });
}

/** POST multipart/form-data. Do not set Content-Type — the browser adds the boundary. */
export async function postForm(path, formData, options = {}) {
  return request(path, {
    ...options,
    method: "POST",
    body: formData,
  });
}

/** PUT a binary body (chunked uploads) with optional headers such as Content-Range. */
export async function putBinary(path, body, options = {}) {
  return request(path, {
    ...options,
    method: "PUT",
    body,
  });
}

export async function patchJson(path, body, options = {}) {
  return request(path, {
    ...options,
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(body),
  });
}

export async function deleteJson(path, options = {}) {
  return request(path, { ...options, method: "DELETE" });
}

/** Plain-language message from a failed request (never "Error: ..." / raw NetworkError). */
export function apiErrorMessage(err, fallback = "Luna couldn't complete that request. Try again.") {
  if (!err) return fallback;
  if (err instanceof ApiError && err.message) {
    if (err.status === 0 || isNetworkFailureMessage(err.message)) {
      return "Couldn't reach Luna. Check this device's connection and try again.";
    }
    return err.message;
  }
  const raw = String(err.message || err).replace(/^Error:\s*/i, "");
  if (isNetworkFailureMessage(raw)) {
    return "Couldn't reach Luna. Check this device's connection and try again.";
  }
  return raw || fallback;
}

async function request(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const res = await apiFetch(path, { ...options, headers });
  if (!res.ok) {
    let message = "";
    try {
      const data = await res.json();
      message = data.error || "";
    } catch {
      // fall through to status text
    }
    throw new ApiError(res.status, message || `Request failed (${res.status})`);
  }
  // Some DELETE handlers return an empty body; treat that as success.
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(res.status, "Luna sent a response this page couldn't read. Try again.");
  }
}

export function getHealth() {
  return getJson("/api/v1/health");
}

export function getDrives() {
  return getJson("/api/v1/drives");
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
  }
}

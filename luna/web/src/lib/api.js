// Minimal Luna API client. One function per endpoint keeps the bundle small
// and makes the server contract explicit.

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) || "";
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

export async function deleteJson(path, options = {}) {
  return request(path, { ...options, method: "DELETE" });
}

/** Plain-language message from a failed request (never "Error: ..."). */
export function apiErrorMessage(err, fallback = "Luna couldn't complete that request. Try again.") {
  if (!err) return fallback;
  if (err instanceof ApiError && err.message) return err.message;
  const raw = String(err.message || err);
  return raw.replace(/^Error:\s*/i, "") || fallback;
}

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie("luna_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const res = await fetch(path, {
    credentials: "include",
    headers,
    ...options,
  });
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
  return res.json();
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

// Minimal Luna API client. One function per endpoint keeps the bundle small
// and makes the server contract explicit.

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
export function apiErrorMessage(err, fallback = "Luna couldn't finish that. Try again.") {
  if (!err) return fallback;
  if (err instanceof ApiError && err.message) return err.message;
  const raw = String(err.message || err);
  return raw.replace(/^Error:\s*/i, "") || fallback;
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json", ...(options.headers || {}) },
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

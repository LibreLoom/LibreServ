// Minimal Luna API client. One function per endpoint keeps the bundle small
// and makes the server contract explicit.

export async function getJson(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await safeText(res));
  }
  return res.json();
}

export function getHealth() {
  return getJson("/api/v1/health");
}

export function getDrives() {
  return getJson("/api/v1/drives");
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
  }
}

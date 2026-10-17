export function readCookie(name) {
  if (typeof document === "undefined" || !document.cookie) return "";
  const parts = document.cookie.split(";");
  for (const p of parts) {
    const [k, ...rest] = p.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

export async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie("luna_connect_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  // Force credentials after opts so callers cannot drop cookies/CSRF.
  const res = await fetch(path, {
    ...opts,
    credentials: "include",
    headers,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const err = /** @type {Error & { status?: number }} */ (
      new Error(data.message || data.error || "That didn't work. Try again.")
    );
    err.status = res.status;
    throw err;
  }
  return data;
}


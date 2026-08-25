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
  const res = await fetch(path, {
    credentials: "include",
    ...opts,
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
    const err = new Error(data.message || data.error || "That didn't work. Try again.");
    err.status = res.status;
    throw err;
  }
  return data;
}

/** @param {string} deviceId @param {string} relativePath */
export async function downloadBackup(deviceId, relativePath) {
  const headers = { "Content-Type": "application/json" };
  const csrf = readCookie("luna_connect_csrf");
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch("/api/v1/backups/download", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ device_id: deviceId, path: relativePath }),
  });
  if (!res.ok) {
    let message = "Could not download that cloud backup.";
    try {
      const data = await res.json();
      message = data.message || data.error || message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = relativePath.split("/").pop() || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

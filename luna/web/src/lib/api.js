// Minimal Luna API client. One function per endpoint keeps the bundle small
// and makes the server contract explicit.
//
// Cookie-authenticated mutations MUST go through these helpers so
// X-CSRF-Token is attached. Raw `fetch` skips CSRF and lunad answers 403
// ("This page expired.") — or, with the Vite proxy rewriting Host, the
// Origin guard returns "Cross-site request blocked."

const SETUP_TOKEN_KEY = "luna_setup_token";

export function getSetupToken() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(SETUP_TOKEN_KEY) || "";
}

/** @param {string} token */
export function setSetupToken(token) {
  if (typeof window === "undefined") return;
  const trimmed = String(token || "").trim();
  if (trimmed) localStorage.setItem(SETUP_TOKEN_KEY, trimmed);
  else localStorage.removeItem(SETUP_TOKEN_KEY);
}

export function clearSetupToken() {
  setSetupToken("");
}

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
  // Remote setup unlock (first ****-**** of the permanent device code).
  if (
    path.startsWith("/api/v1/setup") ||
    path.startsWith("/api/v1/auth/register")
  ) {
    const setupToken = getSetupToken();
    if (setupToken && !headers["X-Setup-Token"]) {
      headers["X-Setup-Token"] = setupToken;
    }
  }
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

/** Like getJson but returns parsed JSON even when status is 503 (health checks). */
export async function getJsonAllowErrorStatus(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const res = await apiFetch(path, { ...options, headers });
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(res.status, "Luna sent a response this page couldn't read. Try again.");
  }
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

/**
 * PUT binary with upload-byte progress (XHR). Use for large chunked uploads so
 * the bar moves while a chunk is still in flight; fetch cannot report that.
 *
 * @param {string} path
 * @param {Blob|ArrayBuffer|Uint8Array} body
 * @param {{
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal,
 *   onProgress?: (loaded: number, total: number) => void,
 * }} [options]
 */
export function putBinaryProgress(path, body, options = {}) {
  const method = "PUT";
  const headers = withCsrfHeaders(method, {
    Accept: "application/json",
    ...(options.headers || {}),
  });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    for (const [key, value] of Object.entries(headers)) {
      if (value != null && value !== "") xhr.setRequestHeader(key, String(value));
    }

    const onAbort = () => xhr.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (!options.onProgress) return;
      let known = 0;
      if (typeof Blob !== "undefined" && body instanceof Blob) known = body.size;
      else if (body instanceof ArrayBuffer) known = body.byteLength;
      else if (ArrayBuffer.isView(body)) known = body.byteLength;
      const total = event.lengthComputable ? event.total : known;
      options.onProgress(event.loaded, total || event.loaded);
    };

    xhr.onload = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        const text = xhr.responseText || "";
        if (!text) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ApiError(xhr.status, "Luna sent a response this page couldn't read. Try again."));
        }
        return;
      }
      let message = "";
      try {
        message = JSON.parse(xhr.responseText || "{}").error || "";
      } catch {
        // fall through
      }
      reject(new ApiError(xhr.status, message || `Request failed (${xhr.status})`));
    };

    xhr.onerror = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ApiError(0, "Couldn't reach Luna. Check this device's connection and try again."));
    };

    xhr.onabort = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    xhr.send(/** @type {XMLHttpRequestBodyInit} */ (body));
  });
}

/**
 * POST multipart/form-data with upload-byte progress and abort (XHR).
 *
 * @param {string} path
 * @param {FormData} formData
 * @param {{
 *   signal?: AbortSignal,
 *   onProgress?: (loaded: number, total: number) => void,
 * }} [options]
 */
export function postFormProgress(path, formData, options = {}) {
  const method = "POST";
  const headers = withCsrfHeaders(method, {
    Accept: "application/json",
  });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    for (const [key, value] of Object.entries(headers)) {
      if (value != null && value !== "") xhr.setRequestHeader(key, String(value));
    }

    const onAbort = () => xhr.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (!options.onProgress) return;
      const total = event.lengthComputable ? event.total : 0;
      options.onProgress(event.loaded, total || event.loaded);
    };

    xhr.onload = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        const text = xhr.responseText || "";
        if (!text) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ApiError(xhr.status, "Luna sent a response this page couldn't read. Try again."));
        }
        return;
      }
      let message = "";
      try {
        message = JSON.parse(xhr.responseText || "{}").error || "";
      } catch {
        // fall through
      }
      reject(new ApiError(xhr.status, message || `Request failed (${xhr.status})`));
    };

    xhr.onerror = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ApiError(0, "Couldn't reach Luna. Check this device's connection and try again."));
    };

    xhr.onabort = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    xhr.send(formData);
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

export async function putJson(path, body, options = {}) {
  return request(path, {
    ...options,
    method: "PUT",
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

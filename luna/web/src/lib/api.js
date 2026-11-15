// Minimal Luna API client. One function per endpoint keeps the bundle small
// and makes the server contract explicit.
//
// Cookie-authenticated mutations MUST go through these helpers so
// X-CSRF-Token is attached. Raw `fetch` skips CSRF and lunad answers 403
// ("This page expired.") — or, with the Vite proxy rewriting Host, the
// Origin guard returns "Luna blocked this request because it came from another website."



function readCookie(name) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length) || "";
}

const UNREACHABLE = "Couldn't reach Luna. Check this device's connection and try again.";

// A cancel is not a network failure, so "aborted" is not in this list.
function isNetworkFailureMessage(raw) {
  return /networkerror|failed to fetch|load failed|network request failed|fetch failed|econnrefused|econnreset/i.test(
    String(raw || ""),
  );
}

/**
 * The plain sentence for a failed request whose body gave no message
 * (a proxy page, an empty body). It names what the status code means.
 * @param {number} status
 */
export function statusMessage(status) {
  if (status === 0) return UNREACHABLE;
  if (status === 403) return "You don't have permission to do this.";
  if (status === 404) return "Luna could not find this. It may have been moved or deleted.";
  if (status === 408 || status === 504) return "Luna took too long to answer. Try again.";
  if (status === 413) return "This is too large for Luna to accept.";
  if (status === 429) return "Luna got too many requests. Wait a moment, then try again.";
  if (status === 502 || status === 503) return "Luna is not answering right now. Wait a moment, then try again.";
  if (status >= 500) return "Luna had a problem and could not finish this. Try again.";
  return `Luna could not finish this request (error ${status}). Try again.`;
}

/** Statuses whose `statusMessage` names a real cause, so it beats a caller's generic fallback. */
const STATUS_WITH_CAUSE = new Set([403, 404, 408, 413, 429, 502, 503, 504]);

/**
 * True when `statusMessage(status)` names a real cause (not found, too large, busy),
 * so it should beat a caller's generic fallback.
 * @param {number} status
 */
export function statusHasCause(status) {
  return STATUS_WITH_CAUSE.has(status);
}

/**
 * lunad's request guards (an expired page, a request from another website)
 * answer 403 too. Callers that read 403 as "wrong password" or "wrong phrase"
 * must check this first.
 * @param {unknown} err
 */
export function isRequestGuardError(err) {
  const code = /** @type {any} */ (err)?.code;
  return code === "page_expired" || code === "cross_site";
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
 * Window event fired when a request comes back 401. AuthProvider listens and
 * re-checks /auth/me: a 401 can also mean "wrong password" or "wrong device
 * token", so only a confirmed dead session signs the user out.
 */
export const UNAUTHORIZED_EVENT = "luna:unauthorized";

/** A page fires many requests at once; one dead session must raise one event, not one per request. */
const UNAUTHORIZED_COALESCE_MS = 2000;
let lastUnauthorizedAt = 0;

function notifyUnauthorized(path) {
  if (typeof window === "undefined") return;
  // /auth/* answers 401 for bad logins; those never mean the session ended.
  if (String(path).startsWith("/api/v1/auth/")) return;
  const now = Date.now();
  if (now - lastUnauthorizedAt < UNAUTHORIZED_COALESCE_MS) return;
  lastUnauthorizedAt = now;
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
}

/**
 * Low-level fetch for callers that need a raw Response. Always includes
 * credentials and attaches X-CSRF-Token on mutating methods.
 */
export async function apiFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = withCsrfHeaders(method, options.headers || {});

  let res;
  try {
    // Spread options first, then force credentials + merged headers so a
    // caller's Content-Type object cannot wipe X-CSRF-Token.
    res = await fetch(path, {
      ...options,
      credentials: "include",
      headers,
    });
  } catch (err) {
    // The caller cancelled: keep the AbortError so it is not shown as a lost connection.
    if (/** @type {any} */ (err)?.name === "AbortError") throw err;
    throw new ApiError(0, UNREACHABLE);
  }
  if (res.status === 401) notifyUnauthorized(path);
  return res;
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
    if (!res.ok) throw new ApiError(res.status);
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    // A failed status with a page that is not JSON (a proxy error page) says what the status means.
    if (!res.ok) throw new ApiError(res.status);
    throw new ApiError(res.status, "Luna answered, but this page could not show the result. Refresh and try again.");
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
 * An ApiError from a failed XHR, carrying the parsed body as `code` and `data`
 * the same way `request` does.
 * @param {XMLHttpRequest} xhr
 */
function xhrApiError(xhr) {
  let message = "";
  let code = null;
  let data;
  try {
    data = JSON.parse(xhr.responseText || "{}");
    message = data?.error || "";
    if (typeof data?.code === "string" && data.code) code = data.code;
  } catch {
    data = undefined;
  }
  return new ApiError(xhr.status, message, code, data);
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
      if (xhr.status === 401) notifyUnauthorized(path);
      if (xhr.status >= 200 && xhr.status < 300) {
        const text = xhr.responseText || "";
        if (!text) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ApiError(xhr.status, "Luna answered, but this page could not show the result. Refresh and try again."));
        }
        return;
      }
      reject(xhrApiError(xhr));
    };

    xhr.onerror = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ApiError(0, UNREACHABLE));
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
      if (xhr.status === 401) notifyUnauthorized(path);
      if (xhr.status >= 200 && xhr.status < 300) {
        const text = xhr.responseText || "";
        if (!text) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ApiError(xhr.status, "Luna answered, but this page could not show the result. Refresh and try again."));
        }
        return;
      }
      reject(xhrApiError(xhr));
    };

    xhr.onerror = () => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ApiError(0, UNREACHABLE));
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

/**
 * Plain-language message from a failed request (never "Error: ..." / raw NetworkError).
 * The status decides "Couldn't reach Luna": only a request with no answer (status 0) gets it.
 * When Luna answered without a message, the caller's `fallback` (which names the action) wins.
 * @param {any} err
 * @param {string} [fallback]
 * @returns {string}
 */
export function apiErrorMessage(err, fallback) {
  const plainFallback = fallback || "Something went wrong. Try again.";
  if (!err) return plainFallback;
  if (err?.name === "AbortError") return "Cancelled";
  if (err instanceof ApiError) {
    if (err.status === 0) return UNREACHABLE;
    // A status with a known cause (not found, too large, busy) says that cause.
    if (err.generic) return fallback && !STATUS_WITH_CAUSE.has(err.status) ? fallback : err.message;
    return err.message || plainFallback;
  }
  const raw = String(err.message || (typeof err === "string" ? err : "")).replace(/^Error:\s*/i, "");
  if (isNetworkFailureMessage(raw)) return UNREACHABLE;
  return raw || plainFallback;
}

async function request(path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const res = await apiFetch(path, { ...options, headers });
  if (!res.ok) {
    let message = "";
    let code = null;
    let data;
    try {
      data = await res.json();
      message = data.error || "";
      if (typeof data.code === "string" && data.code) code = data.code;
    } catch {
      // fall through to status text
    }
    throw new ApiError(res.status, message, code, data);
  }
  // Some DELETE handlers return an empty body; treat that as success.
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(res.status, "Luna answered, but this page could not show the result. Refresh and try again.");
  }
}

export function getDrives() {
  return getJson("/api/v1/drives");
}

export function getRecents() {
  return getJson("/api/v1/me/recents");
}

/**
 * @param {{ kind?: string, driveId: string, path?: string }} item
 */
export function recordRecent({ kind, driveId, path }) {
  return postJson("/api/v1/me/recents", { kind, driveId, path });
}

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} [message]
   * @param {string | null} [code] Stable machine-readable error code from the API body.
   * @param {object} [data] The parsed error body — extra fields like `holder`.
   */
  constructor(status, message, code = null, data = undefined) {
    super(message || statusMessage(status));
    this.name = "ApiError";
    /** True when Luna gave no message of its own, so the text only names the status. */
    this.generic = !message;
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

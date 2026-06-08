let refreshPromise = null;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

/** @param {string} path @param {{ [key: string]: any }} [options] @param {boolean} [retried] */
export default async function api(path, options = {}, retried = false) {
  const { noRetry, ...fetchOptions } = options;
  const url = `/api/v1${path}`;
  const headers = { .../** @type {{ [key: string]: any }} */ (fetchOptions.headers || {}) };
  if (path.startsWith("/setup")) {
    const setupToken = typeof window !== "undefined"
      ? localStorage.getItem("libreserv_setup_token")
      : "";
    if (setupToken) {
      headers["X-Setup-Token"] = setupToken;
    }
  }
  const res = await fetch(url, {
    credentials: "include",
    ...fetchOptions,
    headers,
  });
  if (
    res.status === 401 &&
    !(
      path === "/auth/refresh" ||
      path === "/auth/login" ||
      path === "/auth/logout"
    ) &&
    !retried &&
    !noRetry
  ) {
    if (/** @type {any} */ (import.meta).env?.DEV) console.log(`[api] 401 on ${path}, triggering refresh`);
    // Prevent race conditions by ensuring only one refresh request at a time
    if (!refreshPromise) {
      if (/** @type {any} */ (import.meta).env?.DEV) console.log("[api] creating refresh promise");
      refreshPromise = fetch("/api/v1/auth/refresh", {
        credentials: "include",
        method: "POST",
      });
    }

    try {
      const refreshResponse = await refreshPromise;
      refreshPromise = null;
      if (/** @type {any} */ (import.meta).env?.DEV) console.log(`[api] refresh -> ${refreshResponse.status}`);

      if (refreshResponse.ok) {
        if (/** @type {any} */ (import.meta).env?.DEV) console.log(`[api] refresh ok, retrying ${path}`);
        return await api(path, options, true);
      }

      throw new AuthError("Session expired. Please log in again.");
    } catch (error) {
      refreshPromise = null;
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError("Session expired. Please log in again.");
    }
  }
  if (!res.ok && !options.allowNonOk) {
    let message = `Request failed with status: ${res.status}`;
    try {
      const body = await res.clone().json();
      if (body.error || body.message) {
        message = body.error || body.message;
      }
    } catch {
      // Response body wasn't JSON; fall back to status-only message
    }
    const err = /** @type {any} */ (new Error(message));
    err.cause = { status: res.status, response: res };
    throw err;
  }
  return res;
}

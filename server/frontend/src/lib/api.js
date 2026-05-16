let refreshPromise = null;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

import { triggerSessionExpired } from "../utils/sessionExpiredHandler.js";
export { triggerSessionExpired };

export default async function api(path, options = {}, retried = false) {
  const { noRetry, ...fetchOptions } = options;
  const url = `/api/v1${path}`;
  const headers = {
    ...fetchOptions.headers,
  };
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
    if (import.meta.env.DEV) console.log(`[api] 401 on ${path}, triggering refresh`);
    // Prevent race conditions by ensuring only one refresh request at a time
    if (!refreshPromise) {
      if (import.meta.env.DEV) console.log("[api] creating refresh promise");
      refreshPromise = fetch("/api/v1/auth/refresh", {
        credentials: "include",
        method: "POST",
      });
    }

    try {
      const refreshResponse = await refreshPromise;
      refreshPromise = null;
      if (import.meta.env.DEV) console.log(`[api] refresh -> ${refreshResponse.status}`);

      if (refreshResponse.ok) {
        if (import.meta.env.DEV) console.log(`[api] refresh ok, retrying ${path}`);
        return await api(path, options, true);
      }

      triggerSessionExpired();
      throw new AuthError("Session expired. Please log in again.");
    } catch (error) {
      refreshPromise = null;
      if (error instanceof AuthError) {
        triggerSessionExpired();
        throw error;
      }
      triggerSessionExpired();
      throw new AuthError("Session expired. Please log in again.");
    }
  }
  if (!res.ok && !options.allowNonOk) {
    throw new Error(`Request failed with status: ${res.status}`, {
      cause: {
        status: res.status,
        response: res,
      },
    });
  }
  return res;
}

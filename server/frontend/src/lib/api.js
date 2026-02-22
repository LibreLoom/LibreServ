let refreshPromise = null;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export default async function api(path, options = {}, retried = false) {
  // Keep API versioning in one place and always send cookies for session auth.
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
    // Prevent race conditions by ensuring only one refresh request at a time
    if (!refreshPromise) {
      refreshPromise = fetch("/api/v1/auth/refresh", {
        credentials: "include",
        method: "POST",
      });
    }

    try {
      const refreshResponse = await refreshPromise;
      refreshPromise = null;

      if (refreshResponse.ok) {
        return await api(path, options, true);
      }

      // Refresh failed - user needs to log in again
      throw new AuthError("Session expired. Please log in again.");
    } catch (error) {
      refreshPromise = null;
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError("Session expired. Please log in again.");
    }
  }
  if (!res.ok) {
    // Attach status and response for downstream error handling (login, retries).
    throw new Error(`Request failed with status: ${res.status}`, {
      cause: {
        status: res.status,
        response: res,
      },
    });
  }
  return res;
}

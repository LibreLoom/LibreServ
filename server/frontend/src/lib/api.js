let refreshPromise = null;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

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
    console.log(`[api] 401 on ${path}, triggering refresh`);
    // Prevent race conditions by ensuring only one refresh request at a time
    if (!refreshPromise) {
      console.log("[api] creating refresh promise");
      refreshPromise = fetch("/api/v1/auth/refresh", {
        credentials: "include",
        method: "POST",
      });
    }

    try {
      const refreshResponse = await refreshPromise;
      refreshPromise = null;
      console.log(`[api] refresh -> ${refreshResponse.status}`);

      if (refreshResponse.ok) {
        console.log(`[api] refresh ok, retrying ${path}`);
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
  if (!res.ok) {
    throw new Error(`Request failed with status: ${res.status}`, {
      cause: {
        status: res.status,
        response: res,
      },
    });
  }
  return res;
}

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
    // Attempt a silent refresh once before surfacing an auth error.
    const refreshResponse = await fetch("/api/v1/auth/refresh", {
      credentials: "include",
      method: "POST",
    });
    if (refreshResponse.ok) {
      return await api(path, options, true);
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

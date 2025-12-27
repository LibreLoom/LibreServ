export default async function api(path, options = {}) {
  const url = `/api/v1${path}`;
  const headers = {
    ...options.headers,
  };
  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers,
  });
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

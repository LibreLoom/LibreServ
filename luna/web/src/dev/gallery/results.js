// Marathon results live in luna/web/testing/results.json, written by a dev-server
// route (see vite.config.js) because a page can't write into the repo itself.
const URL_ = "/__states/api/results";

export async function loadResults() {
  try {
    const res = await fetch(URL_);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

export async function saveResult(id, result) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, result }),
  });
  if (!res.ok) throw new Error("Couldn't save the result.");
  return res.json();
}

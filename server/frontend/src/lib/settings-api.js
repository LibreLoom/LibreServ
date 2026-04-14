import api from "./api.js";

export async function getSettings() {
  const res = await api("/settings");
  return res.json();
}

export async function updateSettings(settings, csrfToken) {
  const res = await api("/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}

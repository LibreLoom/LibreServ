import api from "./api.js";

export async function getNotifications() {
  const res = await api("/notify/config");
  return res.json();
}

export async function updateNotifications(settings, csrfToken) {
  const res = await api("/notify/config", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}

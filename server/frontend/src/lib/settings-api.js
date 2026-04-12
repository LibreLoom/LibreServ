import api from "./api.js";

export async function getSettings() {
  const res = await api("/settings");
  return res.json();
}

export async function updateSettings(settings) {
  const res = await api("/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}

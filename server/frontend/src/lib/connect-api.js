import api from "./api.js";

export async function getConnectStatus() {
  const res = await api("/connect/status");
  return res.json();
}

export async function activateConnect(token, csrfToken) {
  const res = await api("/connect/activate", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ license_key: token }),
  });
  return res.json();
}

export async function deactivateConnect(csrfToken) {
  const res = await api("/connect/deactivate", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
  return res.json();
}

export async function updateConnectService(service, state, csrfToken) {
  const res = await api("/connect/services", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ service, state }),
  });
  return res.json();
}

export async function getConnectUsage() {
  const res = await api("/connect/usage");
  return res.json();
}

export async function getConnectInfo() {
  const res = await api("/connect/info");
  return res.json();
}

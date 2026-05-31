import api from "./api.js";

export async function getConnectStatus() {
  return api("/connect/status");
}

export async function activateConnect(token, csrfToken) {
  return api("/connect/activate", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ token }),
  });
}

export async function deactivateConnect(csrfToken) {
  return api("/connect/deactivate", {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken },
  });
}

export async function updateConnectService(service, state, csrfToken) {
  return api("/connect/services", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ service, state }),
  });
}

export async function getConnectUsage() {
  return api("/connect/usage");
}

export async function getConnectInfo() {
  return api("/connect/info");
}

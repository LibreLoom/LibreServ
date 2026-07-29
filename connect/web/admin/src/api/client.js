const TOKEN_KEY = "connect-admin-token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { "Content-Type": "application/json", "Accept": "application/json", ...options.headers };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(path, { ...options, headers, cache: "no-store" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth
  login: (email, password, totpCode) => request("/admin/login", {
    method: "POST",
    body: JSON.stringify({ email, password, totp_code: totpCode || "" }),
  }),
  seedAdmin: (email, password, name) => request("/admin/seed", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  }),
  setup2FA: () => request("/admin/2fa/setup", { method: "POST" }),
  verify2FA: (code) => request("/admin/2fa/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  }),
  changePassword: (currentPassword, newPassword) => request("/admin/password", {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  }),
  listAdmins: () => request("/admin/admins"),
  createAdmin: (email, password, name) => request("/admin/admins", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  }),
  deleteAdmin: (id) => request(`/admin/admins/${id}`, { method: "DELETE" }),

  // Devices
  listDevices: () => request("/admin/devices"),
  getDevice: (id) => request(`/admin/devices/${id}`),
  getDeviceUsage: (id) => request(`/admin/devices/${id}/usage`),
  rotateCredentials: (id, service) => request(`/admin/devices/${id}/credentials/rotate`, {
    method: "POST",
    body: JSON.stringify({ service }),
  }),

  // Cases
  listCases: () => request("/admin/cases"),
  getCase: (id) => request(`/admin/cases/${id}`),
  addCaseMessage: (caseId, text) => request(`/admin/cases/${caseId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  }),
  createConsentRequest: (caseId, body) => request(`/admin/cases/${caseId}/consent-requests`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // Plans
  listPlans: () => request("/admin/plans"),
  updatePlan: (id, body) => request(`/admin/plans/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),

  // Usage
  getAggregatedUsage: () => request("/admin/usage"),

  // Tunnels
  listTunnels: () => request("/admin/tunnels"),

  // AI Models
  listProviders: () => request("/admin/models/providers"),
  createProvider: (body) => request("/admin/models/providers", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateProvider: (id, body) => request(`/admin/models/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  deleteProvider: (id) => request(`/admin/models/providers/${id}`, { method: "DELETE" }),
  listModels: (role) => request(`/admin/models${role ? `?role=${role}` : ""}`),
  createModel: (body) => request("/admin/models", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateModel: (id, body) => request(`/admin/models/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  deleteModel: (id) => request(`/admin/models/${id}`, { method: "DELETE" }),
  getFallbackChain: (role, tier) => request(`/admin/models/fallback/${role}${tier ? `?tier=${tier}` : ""}`),
  setFallbackChain: (role, body) => request(`/admin/models/fallback/${role}`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // Service Providers (backup, smtp, dns)
  listServiceProviders: (service) =>
    request(`/admin/providers${service ? `?service=${service}` : ""}`),
  createServiceProvider: (body) => request("/admin/providers", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateServiceProvider: (id, body) => request(`/admin/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  deleteServiceProvider: (id) => request(`/admin/providers/${id}`, { method: "DELETE" }),
};

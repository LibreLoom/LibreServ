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

const API_BASE = "/api/admin";

async function request(path, options = {}) {
  const token = getToken();
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth
  login: (email, password, totpCode) => request("/login", {
    method: "POST",
    body: JSON.stringify({ email, password, totp_code: totpCode || "" }),
  }),
  seedAdmin: (email, password, name) => request("/seed", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  }),
  setup2FA: () => request("/2fa/setup", { method: "POST" }),
  verify2FA: (code) => request("/2fa/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  }),

  // Devices
  listDevices: () => request("/devices"),
  getDevice: (id) => request(`/devices/${id}`),
  getDeviceUsage: (id) => request(`/devices/${id}/usage`),
  rotateCredentials: (id, service) => request(`/devices/${id}/credentials/rotate`, {
    method: "POST",
    body: JSON.stringify({ service }),
  }),

  // Cases
  listCases: () => request("/cases"),
  getCase: (id) => request(`/cases/${id}`),
  addCaseMessage: (caseId, text) => request(`/cases/${caseId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  }),
  createConsentRequest: (caseId, body) => request(`/cases/${caseId}/consent-requests`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // Plans
  listPlans: () => request("/plans"),
  updatePlan: (id, body) => request(`/plans/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),

  // Usage
  getAggregatedUsage: () => request("/usage"),

  // AI Models
  listProviders: () => request("/models/providers"),
  createProvider: (body) => request("/models/providers", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateProvider: (id, body) => request(`/models/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  deleteProvider: (id) => request(`/models/providers/${id}`, { method: "DELETE" }),
  listModels: (role) => request(`/models${role ? `?role=${role}` : ""}`),
  createModel: (body) => request("/models", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateModel: (id, body) => request(`/models/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }),
  deleteModel: (id) => request(`/models/${id}`, { method: "DELETE" }),
  getFallbackChain: (role, tier) => request(`/models/fallback/${role}${tier ? `?tier=${tier}` : ""}`),
  setFallbackChain: (role, body) => request(`/models/fallback/${role}`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // Relay
  getFleetStatus: () => request("/relay"),
  listRegions: () => request("/relay/regions"),
  createRegion: (body) => request("/relay/regions", {
    method: "POST",
    body: JSON.stringify(body),
  }),
  updateRegionHealth: (id, isHealthy) => request(`/relay/regions/${id}/health`, {
    method: "PUT",
    body: JSON.stringify({ is_healthy: isHealthy }),
  }),
  deleteRegion: (id) => request(`/relay/regions/${id}`, { method: "DELETE" }),
};

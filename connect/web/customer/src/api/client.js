const TOKEN_KEY = "connect-customer-token";

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
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth
  register: (email, password, name) => request("/portal/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  }),
  login: (email, password, totpCode) => request("/portal/login", {
    method: "POST",
    body: JSON.stringify({ email, password, totp_code: totpCode || "" }),
  }),
  setup2FA: () => request("/portal/2fa/setup", { method: "POST" }),
  verify2FA: (code) => request("/portal/2fa/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  }),
  disable2FA: (code) => request("/portal/2fa/disable", {
    method: "POST",
    body: JSON.stringify({ code }),
  }),

  // License keys
  getLicenseKeys: () => request("/portal/license-keys"),
  generateLicenseKey: (planId) => request("/portal/license-keys", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId }),
  }),
  revokeLicenseKey: (keyId) => request("/portal/license-keys/revoke", {
    method: "POST",
    body: JSON.stringify({ key_id: keyId }),
  }),

  // Devices
  getDevices: () => request("/portal/devices"),
  linkDevice: (token) => request("/portal/devices/link", {
    method: "POST",
    body: JSON.stringify({ token }),
  }),

  // Plans
  getPlans: () => request("/portal/plans"),
  subscribe: (planId, deviceId) => request("/portal/subscribe", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId, device_id: deviceId || "" }),
  }),
  cancel: () => request("/portal/cancel", { method: "POST" }),
  changePlan: (planId, deviceId) => request("/portal/change-plan", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId, device_id: deviceId || "" }),
  }),

  // Usage & billing
  getUsage: () => request("/portal/usage"),
  getBilling: () => request("/portal/billing"),

  // Consent
  getConsentRequests: () => request("/portal/consent"),
  respondConsent: (id, decision) => request("/portal/consent/respond", {
    method: "POST",
    body: JSON.stringify({ id, decision }),
  }),
};

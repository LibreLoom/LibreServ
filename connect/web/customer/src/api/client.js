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
  register: (email, password, name, username, source) => request("/portal/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name, username, source: source || "" }),
  }),
  login: (email, password, totpCode) => request("/portal/login", {
    method: "POST",
    body: JSON.stringify({ email, password, totp_code: totpCode || "" }),
  }),
  verifyEmail: (token) => request("/portal/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  }),
  resendVerification: (source) => request("/portal/resend-verification", {
    method: "POST",
    body: JSON.stringify({ source: source || "" }),
  }),
  getVerificationStatus: () => request("/portal/verification-status"),
  getMe: () => request("/portal/me"),
  setup2FA: () => request("/portal/2fa/setup", { method: "POST" }),
  verify2FA: (code) => request("/portal/2fa/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  }),
  disable2FA: (code) => request("/portal/2fa/disable", {
    method: "POST",
    body: JSON.stringify({ code }),
  }),

  // Connect keys
  getConnectKeys: () => request("/portal/connect-keys"),
  generateConnectKey: (subdomain) => request("/portal/connect-keys", {
    method: "POST",
    body: JSON.stringify({ subdomain: subdomain || "" }),
  }),
  revokeConnectKey: (keyId) => request("/portal/connect-keys/revoke", {
    method: "POST",
    body: JSON.stringify({ key_id: keyId }),
  }),

  // Devices
  getDevices: () => request("/portal/devices"),
  useSubdomain: (deviceId) => request("/portal/devices/use-subdomain", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId }),
  }),
  checkSubdomain: (subdomain) => request("/portal/devices/check-subdomain", {
    method: "POST",
    body: JSON.stringify({ subdomain }),
  }),
  setSubdomain: (deviceId, subdomain) => request("/portal/devices/set-subdomain", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId, subdomain }),
  }),
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
  resumeSubscription: () => request("/portal/resume", { method: "POST" }),
  changePlan: (planId, deviceId) => request("/portal/change-plan", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId, device_id: deviceId || "" }),
  }),
  createCheckout: (planId, deviceId) => request("/portal/checkout", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId, device_id: deviceId || "" }),
  }),
  getBillingPortal: () => request("/portal/billing-portal", { method: "POST" }),

  // Usage & billing
  getUsage: () => request("/portal/usage"),
  getBilling: () => request("/portal/billing"),

  // Consent
  getConsentRequests: () => request("/portal/consent"),
  respondConsent: (id, decision) => request("/portal/consent/respond", {
    method: "POST",
    body: JSON.stringify({ id, decision }),
  }),
  // Domains
  searchDomains: (query) => request("/portal/domains/search", {
    method: "POST",
    body: JSON.stringify({ query }),
  }),
  checkDomain: (domain) => request("/portal/domains/check", {
    method: "POST",
    body: JSON.stringify({ domain }),
  }),
  registerDomain: (deviceId, domain) => request("/portal/domains/register", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId, domain }),
  }),
  getDomains: () => request("/portal/domains"),
  getDomainDetails: (domain) => request(`/portal/domains/${encodeURIComponent(domain)}`),
  cancelDomain: (domain) => request(`/portal/domains/${encodeURIComponent(domain)}/cancel`, { method: "POST" }),
  changeDomain: (deviceId, domain) => request("/portal/domains/change", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId, new_domain: domain }),
  }),
};

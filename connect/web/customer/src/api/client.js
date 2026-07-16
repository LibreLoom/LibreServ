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
  login: (token) => request("/portal/login", {
    method: "POST",
    body: JSON.stringify({ token }),
  }),
  getPlans: () => request("/portal/plans"),
  getDevice: () => request("/portal/devices"),
  getUsage: () => request("/portal/usage"),
  getBilling: () => request("/portal/billing"),
  subscribe: (planId) => request("/portal/subscribe", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId }),
  }),
  cancel: () => request("/portal/cancel", { method: "POST" }),
  changePlan: (planId) => request("/portal/change-plan", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId }),
  }),
};

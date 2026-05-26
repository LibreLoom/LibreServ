import api from "./api";

export async function getCaddyStatus() {
  const res = await api("/network/status");
  return res.json();
}

export async function listRoutes() {
  const res = await api("/network/routes");
  return res.json();
}

export async function getCaddyfile() {
  const res = await api("/network/caddyfile");
  const data = await res.json();
  return data.content || "";
}

export async function testBackend(backendUrl) {
  const res = await api("/network/test-backend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend: backendUrl }),
  });
  return res.json();
}

export async function getConnectivityStatus() {
  const res = await api("/network/connectivity");
  return res.json();
}

export async function getUPnPStatus() {
  const res = await api("/network/upnp/status");
  return res.json();
}

export async function getDDNSStatus() {
  const res = await api("/network/ddns/status");
  return res.json();
}

export async function ddnsForceUpdate() {
  const res = await api("/network/ddns/update-now", { method: "POST" });
  return res.json();
}

export async function ddnsSetInterval(minutes) {
  const res = await api("/network/ddns/interval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interval_minutes: minutes }),
  });
  return res.json();
}

export async function getTunnelStatus() {
  const res = await api("/network/tunnel/status");
  if (!res.ok) return { enabled: false, available: false };
  return res.json();
}

export async function enableTunnel(provider, token) {
  const res = await api("/network/tunnel/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, token }),
  });
  return res.json();
}

export async function disableTunnel() {
  const res = await api("/network/tunnel/disable", { method: "POST" });
  return res.json();
}

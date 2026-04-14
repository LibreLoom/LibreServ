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

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

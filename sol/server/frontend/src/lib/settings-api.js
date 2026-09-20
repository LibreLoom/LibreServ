import api from "./api.js";

export async function getSettings() {
  const res = await api("/settings");
  return res.json();
}

export async function updateSettings(settings, csrfToken) {
  const res = await api("/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(settings),
  });
  return res.json();
}

export async function getAISettings() {
  const res = await api("/settings/ai-support");
  return res.json();
}

export async function updateAISettings(aiSettings, csrfToken) {
  const res = await api("/settings/ai-support", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(aiSettings),
  });
  return res.json();
}

export async function fetchAIModels(baseURL, apiKey, csrfToken, apiFormat = "openai") {
  const res = await api("/settings/ai-support/models", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify({ base_url: baseURL, api_key: apiKey, api_format: apiFormat }),
  });
  return res.json();
}

// Keeps the fake lunad's memory across full page loads inside the frame (a sign-out
// redirect, an update restart, window.location). Lives in sessionStorage under one key,
// tagged with the scenario so another scenario never inherits it. The gallery's reload
// and "Open on its own" start with ?__mock=..., which boot.js treats as a fresh start.

const KEY = "luna.mockWorld";

// JSON has no Set and no Map; worlds may hold either.
const replacer = (_k, v) => {
  if (v instanceof Set) return { __set: [...v] };
  // A Map round-trips as `{}` otherwise, which comes back as a plain object —
  // so a link unlocked before a reload would throw on the next request.
  if (v instanceof Map) return { __map: [...v] };
  return v;
};
const reviver = (_k, v) => {
  if (v && typeof v === "object") {
    if (Array.isArray(v.__set)) return new Set(v.__set);
    if (Array.isArray(v.__map)) return new Map(v.__map);
  }
  return v;
};

export function saveState(scenarioId, state) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ scenarioId, state }, replacer));
    return true;
  } catch {
    // Quota or blocked storage: the world just won't survive a reload.
    return false;
  }
}

export function loadState(scenarioId) {
  try {
    const text = sessionStorage.getItem(KEY);
    if (!text) return null;
    const saved = JSON.parse(text, reviver);
    return saved?.scenarioId === scenarioId ? saved.state : null;
  } catch {
    return null;
  }
}

export function clearState() {
  try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

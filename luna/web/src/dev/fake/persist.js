// Keeps the fake lunad's memory across full page loads inside the frame (a sign-out
// redirect, an update restart, window.location). Lives in sessionStorage under one key,
// tagged with the scenario so another scenario never inherits it. The gallery's reload
// and "Open on its own" start with ?__mock=..., which boot.js treats as a fresh start.

const KEY = "luna.mockWorld";

// JSON has no Set; worlds may hold one.
const replacer = (_k, v) => (v instanceof Set ? { __set: [...v] } : v);
const reviver = (_k, v) => (v && typeof v === "object" && Array.isArray(v.__set) ? new Set(v.__set) : v);

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

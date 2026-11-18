// Starts the fake lunad before the app renders. Reached only from main.jsx in
// dev. A page opened with ?__mock=<scenario-id> starts that scenario with FRESH data
// (the gallery's reload, "Open on its own"). The id is kept in sessionStorage, and so
// is the world: a full page load without the flag (sign-out redirect, update restart,
// window.location) picks the same world up where it was.
import "./fake/handlers/index.js";
import { installFake } from "./fake/engine.js";
import { createWorld, DEFAULT_NOW, restoreIdState } from "./fake/world.js";
import { clearState, loadState, saveState } from "./fake/persist.js";
import { freezeClock } from "./fake/clock.js";
import { scenarioById } from "./scenarios/registry.js";

const KEY = "luna.mockScenario";
const SAVE_DELAY_MS = 300;

/** @returns {{ id: string | null, fresh: boolean }} */
export function activeScenario() {
  const fromUrl = new URLSearchParams(window.location.search).get("__mock");
  if (fromUrl) {
    try { sessionStorage.setItem(KEY, fromUrl); } catch { /* storage blocked */ }
    return { id: fromUrl, fresh: true };
  }
  try { return { id: sessionStorage.getItem(KEY), fresh: false }; } catch { return { id: null, fresh: false }; }
}
export const activeScenarioId = () => activeScenario().id;

/** Saves the world now, and again shortly after anything changes. */
export function keepWorld(control, scenarioId, { delay = SAVE_DELAY_MS } = {}) {
  /** @type {any} */
  let timer = 0;
  const save = () => { clearTimeout(timer); saveState(scenarioId, control.exportState()); };
  control.subscribe(() => { clearTimeout(timer); timer = setTimeout(save, delay); });
  window.addEventListener("pagehide", save);
  save();
  return save;
}

/** Returns true when the fake took over. */
export function bootMock() {
  const { id, fresh } = activeScenario();
  if (!id) return false;
  const scenario = scenarioById(id);
  if (!scenario) {
    console.warn(`[mock] Unknown scenario "${id}"`);
    return false;
  }
  // The query flag has done its job; keep the real route clean.
  const url = new URL(window.location.href);
  if (url.searchParams.has("__mock")) {
    url.searchParams.delete("__mock");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  if (scenario.theme) {
    try { localStorage.setItem("theme", scenario.theme); } catch { /* storage blocked */ }
  }
  if (fresh) clearState();
  const saved = fresh ? null : loadState(id);

  let control;
  if (saved) {
    restoreIdState(saved.ids);
    control = installFake({ world: saved.world, scenario, now: saved.clock?.base ?? scenario.now ?? DEFAULT_NOW, restored: saved });
  } else {
    // The clock first, so a seed that reads "now" gets the scenario's now.
    const clock = freezeClock(scenario.now ?? DEFAULT_NOW);
    const world = createWorld(scenario.seed);
    control = installFake({ world, scenario, now: scenario.now ?? DEFAULT_NOW, restored: { clock } });
    if (scenario.offline) control.setOffline(true);
    if (scenario.latency) control.setLatency(scenario.latency);
    for (const f of scenario.faults || []) control.addFault(f);
    if (scenario.restart) control.restartServer(0, scenario.restart);
  }
  control.saveNow = keepWorld(control, id);
  showFakeBadge(id);
  return true;
}

/**
 * A tab opened from the gallery keeps its fake world for as long as the tab
 * lives, and looks exactly like a real Luna. This badge says which one it is
 * and leaves the fake. Hidden inside the gallery's own frames so it never
 * lands in a captured state.
 * @param {string} id
 */
function showFakeBadge(id) {
  if (window.self !== window.top) return;
  const mount = () => {
    const badge = document.createElement("div");
    badge.className =
      "fixed bottom-3 left-3 z-[2147483647] flex items-center gap-2 rounded-pill surface-secondary border-2 border-accent px-3 py-1 text-xs";
    badge.setAttribute("role", "note");
    const label = document.createElement("span");
    label.textContent = `Fake Luna: ${id}`;
    label.title = "This tab runs the state gallery's fake Luna, not your real one.";
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "underline decoration-accent";
    leave.textContent = "Leave";
    leave.addEventListener("click", () => {
      try { sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
      clearState();
      window.location.reload();
    });
    badge.append(label, leave);
    document.body.appendChild(badge);
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
}

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
  return true;
}

// Starts the fake lunad before the app renders. Reached only from main.jsx in
// dev. A page opened with ?__mock=<scenario-id> runs against the fake; the id is
// kept in sessionStorage so in-app navigation and reloads stay in the scenario.
import "./fake/handlers/index.js";
import { installFake } from "./fake/engine.js";
import { createWorld, DEFAULT_NOW } from "./fake/world.js";
import { scenarioById } from "./scenarios/registry.js";

const KEY = "luna.mockScenario";

export function activeScenarioId() {
  const fromUrl = new URLSearchParams(window.location.search).get("__mock");
  if (fromUrl) {
    try { sessionStorage.setItem(KEY, fromUrl); } catch { /* storage blocked */ }
    return fromUrl;
  }
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}

/** Returns true when the fake took over. */
export function bootMock() {
  const id = activeScenarioId();
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
  const control = installFake({ world: createWorld(scenario.seed), scenario, now: scenario.now ?? DEFAULT_NOW });
  if (scenario.offline) control.setOffline(true);
  if (scenario.latency) control.setLatency(scenario.latency);
  for (const f of scenario.faults || []) control.addFault(f);
  return true;
}

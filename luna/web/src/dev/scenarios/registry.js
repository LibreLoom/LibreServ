// Scenarios live in *.scenarios.js files next to each other, one per product area,
// so areas can be filled in independently. Each file default-exports an array of
// scenario objects. See README.md for the shape and the axes to cover.
/** @type {Record<string, { default?: Scenario[] }>} */
const modules = /** @type {any} */ (import.meta.glob("./*.scenarios.js", { eager: true }));

/** @typedef {{
 *   id: string, area: string, title: string,
 *   check?: string[],            // what the tester should look for
 *   url?: string,                // start route, default "/"
 *   seed?: (world: any) => void, // edits the base world
 *   faults?: Array<{ match: string, mode: string, message?: string, code?: string, once?: boolean }>,
 *   now?: number,                // frozen start time (ms)
 *   offline?: boolean, latency?: number,
 *   viewport?: "phone" | "tablet" | "desktop",
 *   theme?: "light" | "dark",
 *   realLunadOnly?: string,      // set when a fake can't stand in (office editors, ...)
 * }} Scenario */

/** @type {Scenario[]} */
export const scenarios = Object.values(modules)
  .flatMap((m) => m.default || [])
  .map((s) => ({ url: "/", check: [], ...s }));

const seen = new Set();
for (const s of scenarios) {
  if (seen.has(s.id)) throw new Error(`Duplicate scenario id: ${s.id}`);
  seen.add(s.id);
}

export const scenarioById = (id) => scenarios.find((s) => s.id === id);

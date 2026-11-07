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
 *   faults?: Array<{ match: string, mode: string, message?: string, code?: string, once?: boolean, on?: boolean }>,
 *   now?: number,                // frozen start time (ms)
 *   offline?: boolean, latency?: number,
 *   restart?: number,           // lunad is down for this many ms from the start (as after an update)
 *   viewport?: "phone" | "tablet" | "desktop",
 *   theme?: "light" | "dark",
 *   realLunadOnly?: string,      // set when a fake can't stand in (office editors, ...)
 * }} Scenario */

// TEMPORARY review grouping for the 2026-11-06 issue sweep. Delete this block
// and the map in `scenarios` below once the review pass is done — the
// scenarios go back to their real areas.
const REVIEW_AREA = "Review: 2026-11-06";
const REVIEW_IDS = new Set([
  // Settings — update source
  "settings/update-source",
  "settings/update-source-lan-feed",
  // Settings — users and private folders
  "settings/users-many",
  "settings/users-orphans",
  "settings/edit-user",
  "settings/edit-user-self",
  "settings/edit-user-save-fails",
  "settings/edit-user-phone",
  "files/private-ownerless",
  // Settings — appearance
  "settings/appearance",
  // Settings — Luna Connect and cloud backup
  "settings/cloud-backups",
  "settings/cloud-no-card",
  "settings/cloud-run-fails",
  "settings/phrase-not-set",
  "settings/phrase-check-wrong",
  "settings/restore-needed",
  "settings/restore-private-needed",
  "settings/phrase-24-words",
  "settings/phrase-set-check-due",
  "settings/phrase-change",
  "settings/phrase-change-exposed",
  "settings/phrase-lost-exposed",
  "settings/phrase-lost",
  "settings/phrase-resealing",
  "settings/phrase-moving",
  "settings/phrase-moving-full",
  "auth/member-needs-phrase",
  // Files — copy, health, folders and speed
  "dashboard/member-calm",
  "auth/member",
  "files/health-unknown",
  "files/upload-folder",
  "files/edit-markdown",
  "files/edit-form",
  "files/edit-form-collab",
  "files/open-close-speed",
  // Files — encryption
  "files/encryption",
  "files/encryption-locked",
  // Shared page and public links
  "shared/many",
  "shared/loading",
  "public/file-edit",
  // Recovery file page
  "recovery/create",
  "recovery/phone-dark",
  // Photos
  "gallery/segment-motion",
]);

/** @type {Scenario[]} */
export const scenarios = Object.values(modules)
  .flatMap((m) => m.default || [])
  .map((s) => (REVIEW_IDS.has(s.id) ? { ...s, area: REVIEW_AREA } : s))
  .map((s) => ({ url: "/", check: [], ...s }));

const seen = new Set();
for (const s of scenarios) {
  if (seen.has(s.id)) throw new Error(`Duplicate scenario id: ${s.id}`);
  seen.add(s.id);
}

export const scenarioById = (id) => scenarios.find((s) => s.id === id);

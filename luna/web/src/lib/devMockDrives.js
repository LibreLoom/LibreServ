/**
 * Dev-only UI fallbacks for drive state. Prefer the real mock-drive system
 * (`make mock-drive`) so lunad owns detection; these only change what the UI shows.
 *
 * Gating:
 * - Never in production builds (`import.meta.env.PROD`).
 * - Unknown-drive review card: default OFF — opt in via query/localStorage.
 *   Toggle: `?mockUnknownDrive=1|0` or `localStorage.luna.mockUnknownDrive=1|0`.
 * - No drives: default ON in `npm run dev` (so the running Luna shows no drives),
 *   OFF in Vitest. Toggle: `?mockNoDrives=1|0` or `localStorage.luna.mockNoDrives=1|0`.
 *   It hides every detected and added drive while lunad keeps its real ones.
 */

/** @type {"sdmock"} */
export const MOCK_UNKNOWN_PSSD_NAME = "sdmock";

/** ~64 GB (decimal), matching the sizeLabel helper on FilesPage. */
const MOCK_SIZE_BYTES = 64_000_000_000;

/**
 * Reads an opt-in dev flag from `?name=1|0` or `localStorage.luna.name`.
 * Returns null when neither is set, so each caller picks its own default.
 * @param {string} name
 * @returns {boolean | null}
 */
function readDevFlag(name) {
  // Production builds must never fake anything.
  if (import.meta.env.PROD || import.meta.env.MODE === "production") return false;
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const query = params.get(name);
  if (query === "0" || query === "false") return false;
  if (query === "1" || query === "true") return true;

  try {
    const stored = window.localStorage.getItem(`luna.${name}`);
    if (stored === "0" || stored === "false") return false;
    if (stored === "1" || stored === "true") return true;
  } catch {
    // private mode / blocked storage — fall through to the default
  }

  return null;
}

/** @returns {boolean} */
export function shouldShowMockUnknownDrive() {
  // Default off — use `make mock-drive` / lunad mock-drives for fixtures.
  return readDevFlag("mockUnknownDrive") === true;
}

/** @returns {boolean} */
export function shouldMockNoDrives() {
  const flag = readDevFlag("mockNoDrives");
  if (flag !== null) return flag;
  // Default on in `npm run dev` only, never in Vitest (MODE "test").
  return import.meta.env.MODE === "development";
}

/** @returns {{ name: string, model: string, size_bytes: number, removable: boolean, usb: boolean, mount_point: null, fs_type: string }} */
export function mockUnknownPssd() {
  return {
    name: MOCK_UNKNOWN_PSSD_NAME,
    model: "64GB PSSD",
    size_bytes: MOCK_SIZE_BYTES,
    removable: true,
    usb: true,
    mount_point: null,
    fs_type: "exfat",
  };
}

/** @param {string | undefined} name */
export function isMockUnknownDrive(name) {
  return name === MOCK_UNKNOWN_PSSD_NAME;
}

/**
 * When the API returns no unknown drives, inject the review fixture if gated on.
 * Real detected drives always win — we never hide hardware.
 * The no-drives mock wins over both.
 *
 * @param {any[] | undefined | null} drives
 * @returns {any[]}
 */
export function withDevMockDetected(drives) {
  const list = Array.isArray(drives) ? drives : [];
  if (shouldMockNoDrives()) return [];
  if (list.length > 0) return list;
  if (!shouldShowMockUnknownDrive()) return list;
  return [mockUnknownPssd()];
}

/**
 * Hides every added drive while the no-drives mock is on.
 * Otherwise returns the list unchanged.
 *
 * @param {any[] | undefined | null} drives
 * @returns {any[]}
 */
export function withDevMockAdopted(drives) {
  const list = Array.isArray(drives) ? drives : [];
  return shouldMockNoDrives() ? [] : list;
}

/** Fake Add-drive inspect result so the adopt modal is reviewable without lunad. */
export function mockInspectResult() {
  return {
    device: MOCK_UNKNOWN_PSSD_NAME,
    model: "64GB PSSD",
    fs_type: "exfat",
    mount_point: "/mnt/mock-pssd",
    mounted_by_luna: true,
    has_marker: false,
    folders: 3,
    files: 12,
    unreadable: 0,
    entries: [
      { name: "Documents", kind: "folder" },
      { name: "Photos", kind: "folder" },
      { name: "Videos", kind: "folder" },
      { name: "readme.txt", kind: "file" },
    ],
    needs_erase: false,
    readable: true,
    writable: true,
  };
}

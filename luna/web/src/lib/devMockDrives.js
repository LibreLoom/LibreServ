/**
 * Dev-only fallback when lunad is not running the mock PSSD (UI-only review).
 * When lunad reports `sdmock` from `/api/v1/drives/detected`, the real API
 * handles inspect/adopt — this module only injects the card if the API is empty.
 *
 * Gating:
 * - Never in production builds (`import.meta.env.PROD`).
 * - On by default in Vite `npm run dev` (`MODE === "development"`).
 * - Off in Vitest (`MODE === "test"`) unless opted in.
 * - Toggle: `?mockUnknownDrive=1|0` or `localStorage.luna.mockUnknownDrive=1|0`.
 */

/** @type {const} */
export const MOCK_UNKNOWN_PSSD_NAME = "sdmock";

/** ~64 GB (decimal), matching the sizeLabel helper on DrivesPage. */
const MOCK_SIZE_BYTES = 64_000_000_000;

/** @returns {boolean} */
export function shouldShowMockUnknownDrive() {
  // Production builds must never show fake hardware.
  if (import.meta.env.PROD || import.meta.env.MODE === "production") return false;
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  const query = params.get("mockUnknownDrive");
  if (query === "0" || query === "false") return false;
  if (query === "1" || query === "true") return true;

  try {
    const stored = window.localStorage.getItem("luna.mockUnknownDrive");
    if (stored === "0" || stored === "false") return false;
    if (stored === "1" || stored === "true") return true;
  } catch {
    // private mode / blocked storage — fall through to MODE default
  }

  // Default on only for the Vite review server, not unit tests.
  return import.meta.env.DEV && import.meta.env.MODE === "development";
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
 *
 * @param {any[] | undefined | null} drives
 * @returns {any[]}
 */
export function withDevMockDetected(drives) {
  const list = Array.isArray(drives) ? drives : [];
  if (list.length > 0) return list;
  if (!shouldShowMockUnknownDrive()) return list;
  return [mockUnknownPssd()];
}

/** Fake Look-inside result so the adopt modal is reviewable without lunad. */
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
    needs_erase: false,
    readable: true,
    writable: true,
  };
}

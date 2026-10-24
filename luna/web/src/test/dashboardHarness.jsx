import { vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../context/AuthContext.jsx";
import DashboardPage from "../pages/DashboardPage.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { readRecentItems } from "../lib/recentItems.js";

/**
 * Shared fetch stub and render helper for the dashboard page tests.
 * Importing this module has no effects: nothing is stubbed, rendered or read
 * until one of the functions below is called.
 */

/**
 * @typedef {object} DashboardFetchOptions
 * @property {string} [username] Signed-in name. Default "max".
 * @property {string} [role] "admin" or "user". Default "admin".
 * @property {string} [userId] Id returned by /api/v1/auth/me. Default "u1".
 * @property {Array<Record<string, any>>} [drives] Answer for /api/v1/drives.
 * @property {Array<Record<string, any>>} [detected] Answer for /api/v1/drives/detected.
 * @property {Record<string, Record<string, any>>} [summaries] Drive id to summary body.
 *   Ids not listed answer mounted:false with no numbers.
 * @property {Record<string, Record<string, any> | null>} [health] Drive id to health body.
 *   Ids not listed answer the default healthy body. A null entry answers null.
 * @property {Record<string, any>} [systemChecks] Answer for /api/v1/system/health/check.
 * @property {Array<Record<string, any>>} [backups] Answer for /api/v1/backups.
 * @property {Array<Record<string, any>>} [cloudBackups] Answer for /api/v1/cloud/backups.
 * @property {Record<string, any>} [phrase] Answer for /api/v1/cloud/phrase.
 * @property {any} [connect] Answer for /api/v1/connect/status. Pass 403 to answer HTTP 403.
 * @property {any} [network] Answer for /api/v1/network/status. Pass 403 to answer HTTP 403.
 * @property {Array<Record<string, any>>} [access] Answer for /api/v1/me/access.
 * @property {Array<Record<string, any>>} [albums] Answer for /api/v1/gallery/albums.
 * @property {Array<Record<string, any>>} [recents] Answer for /api/v1/me/recents. When
 *   omitted, the stub reads the user's saved recents from localStorage at request time.
 * @property {boolean} [connectActive] Answer for /api/v1/auth/status connect_active.
 */

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Response}
 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {Record<string, any>} map
 * @param {string} key
 * @returns {boolean}
 */
function has(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** @param {string} id */
function unmountedSummary(id) {
  return {
    id,
    mounted: false,
    total_bytes: null,
    free_bytes: null,
    used_bytes: null,
    shortcuts: [],
  };
}

/** @returns {Record<string, any>} */
function defaultHealth() {
  return { available: true, overall: "passed", reallocated_sectors: 0, temperature_c: 30 };
}

/**
 * Stubs global fetch with every endpoint the dashboard calls.
 * Unknown paths answer 404.
 *
 * @param {DashboardFetchOptions} [opts]
 * @returns {import("vitest").Mock}
 */
export function stubDashboardFetch(opts = {}) {
  const {
    username = "max",
    role = "admin",
    userId = "u1",
    drives = [{ id: "d1", label: "Family photos", state: "as_is", device: "sda1", fs_type: "exfat" }],
    detected = [],
    summaries = {
      d1: {
        id: "d1",
        mounted: true,
        total_bytes: 64000000000,
        free_bytes: 30000000000,
        used_bytes: 34000000000,
        shortcuts: ["Photos", "Documents"],
      },
    },
    health = {},
    systemChecks = { overall_pass: true, checks: {} },
    backups = [],
    cloudBackups = [],
    phrase = { set: true, set_at: 0, luna_id: "luna-1", signing_public: "", check_due: false, phrase_words: 12 },
    connect = { enabled: false },
    network = { ethernet_connected: true, has_default_route: true },
    access = [],
    albums = [],
    recents,
    connectActive = false,
  } = opts;

  const fetchMock = vi.fn(async (/** @type {any} */ url) => {
    // Match on the pathname so query strings (for example ?drive=) still route.
    const path = new URL(String(url), "http://localhost").pathname;

    if (path === "/api/v1/me/recents") {
      return jsonResponse(recents !== undefined ? recents : readRecentItems(username));
    }
    if (path === "/api/v1/auth/me") {
      return jsonResponse({ id: userId, username, role });
    }
    if (path === "/api/v1/auth/status") {
      return jsonResponse({ has_admin: role === "admin", connect_active: connectActive });
    }
    if (path === "/api/v1/setup") {
      return jsonResponse({ name: "Luna", setup_completed: true });
    }
    if (path === "/api/v1/drives/detected") return jsonResponse(detected);
    if (path === "/api/v1/drives") return jsonResponse(drives);

    const summaryMatch = path.match(/^\/api\/v1\/drives\/([^/]+)\/summary$/);
    if (summaryMatch) {
      const id = summaryMatch[1];
      return jsonResponse(has(summaries, id) ? summaries[id] : unmountedSummary(id));
    }
    const healthMatch = path.match(/^\/api\/v1\/drives\/([^/]+)\/health$/);
    if (healthMatch) {
      const id = healthMatch[1];
      return jsonResponse(has(health, id) ? health[id] : defaultHealth());
    }
    const inspectMatch = path.match(/^\/api\/v1\/drives\/([^/]+)\/inspect$/);
    if (inspectMatch) {
      return jsonResponse({
        device: inspectMatch[1],
        model: "SanDisk",
        fs_type: "exfat",
        readable: true,
        writable: true,
        needs_erase: false,
        has_marker: false,
        folders: 1,
        files: 2,
        entries: [
          { kind: "folder", name: "Photos" },
          { kind: "file", name: "readme.txt" },
        ],
      });
    }

    if (path === "/api/v1/system/health/check") return jsonResponse(systemChecks);
    if (path === "/api/v1/system/updates") return jsonResponse({ update_available: false });
    if (path === "/api/v1/backups") return jsonResponse(backups);
    if (path === "/api/v1/cloud/backups") return jsonResponse(cloudBackups);
    if (path === "/api/v1/cloud/phrase") return jsonResponse(phrase);
    if (path === "/api/v1/network/status") {
      if (network === 403) return jsonResponse({ error: "nope" }, 403);
      return jsonResponse(network);
    }
    if (path === "/api/v1/connect/status") {
      if (connect === 403) return jsonResponse({ error: "nope" }, 403);
      return jsonResponse(connect);
    }
    if (path === "/api/v1/me/access") return jsonResponse(access);
    if (path === "/api/v1/gallery/albums") return jsonResponse(albums);
    if (path === "/api/v1/users") return jsonResponse([]);
    if (path === "/api/v1/private-backups/summary") return jsonResponse({ owners: [] });
    // Opened from a backup row's protect sheet: an ordinary (not private) item.
    if (path === "/api/v1/private-backups/item") {
      return jsonResponse({ private: false, inside_private: false, mine: false, owner_name: "" });
    }

    return jsonResponse({}, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Renders DashboardPage inside the same providers the app uses.
 * Each call makes a fresh QueryClient with retries off.
 *
 * @returns {ReturnType<typeof render>}
 */
export function renderDashboard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <ToastProvider>
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <DashboardPage />
          </AuthProvider>
        </QueryClientProvider>
      </MemoryRouter>
    </ToastProvider>,
  );
}

/**
 * A drive backup row as /api/v1/backups returns it.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
export function backupRow(overrides = {}) {
  return {
    id: "b1",
    kind: "drive",
    source_drive: "d1",
    source_drive_name: "Photos drive",
    source_path: "Photos",
    source_name: "Photos",
    target_drive: "d2",
    target_drive_name: "Backup drive",
    state: "ok",
    status: "active",
    stop_reason: "",
    last_ok_at: Math.floor(Date.now() / 1000) - 3600,
    last_error: "",
    hard: false,
    first_done: true,
    created_by: "u1",
    can_delete: true,
    ...overrides,
  };
}

/**
 * A cloud backup row as /api/v1/cloud/backups returns it.
 *
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
export function cloudBackupRow(overrides = {}) {
  return backupRow({
    id: "c1",
    kind: "cloud",
    source_name: "Documents",
    source_path: "Documents",
    target_drive: undefined,
    target_drive_name: undefined,
    last_checked_at: Math.floor(Date.now() / 1000) - 3 * 24 * 3600,
    check_problem: "",
    source_missing: false,
    ...overrides,
  });
}

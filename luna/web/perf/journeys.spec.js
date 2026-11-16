// Luna web journey timings (luna/perf/budgets.json, W1–W16).
//
// Runs against a real lunad (LUNA_PERF_BASE_URL), repeats each journey,
// reads the app's own timing points from window.__lunaPerf
// (src/lib/perf.js), and writes p50/p95 against the budgets to
// luna/perf/results/web-journeys-<run>.json (+ web-journeys-latest.json).
// Over-budget journeys are reported, not failed. Settings are env vars; see
// luna/perf/README.md → Web.
import { test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERF_DIR = path.resolve(HERE, "../../perf");
const RESULTS_DIR = path.join(PERF_DIR, "results");
const BUDGETS = JSON.parse(readFileSync(path.join(PERF_DIR, "budgets.json"), "utf8"));

const env = process.env;
const int = (value, fallback) => (Number.isFinite(Number.parseInt(value, 10)) ? Number.parseInt(value, 10) : fallback);
const RUNS = Math.max(1, int(env.LUNA_PERF_RUNS, 10));
// lunad allows 10 sign-in tries per 5 minutes per address and per username.
const LOGIN_RUNS = Math.min(Math.max(1, int(env.LUNA_PERF_LOGIN_RUNS, 5)), 8);
const SCROLL_RUNS = Math.max(1, int(env.LUNA_PERF_SCROLL_RUNS, 3));
const SCROLL_STEP_PX = Math.max(10, int(env.LUNA_PERF_SCROLL_STEP, 120));
const OFFICE_RUNS = Math.max(1, int(env.LUNA_PERF_OFFICE_RUNS, 5));
const CPU_THROTTLE = Math.max(1, Number(env.LUNA_PERF_CPU_THROTTLE) || 1);
const NETWORK = env.LUNA_PERF_NETWORK === "remote" ? "remote" : "lan";
const USER = env.LUNA_PERF_USER || "admin";
const PASSWORD = env.LUNA_PERF_PASSWORD || "";
const ONLY = env.LUNA_PERF_JOURNEYS
  ? new Set(env.LUNA_PERF_JOURNEYS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))
  : null;
const RUN_ID = env.LUNA_PERF_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-");
const RESULTS_FILE = path.join(RESULTS_DIR, `web-journeys-${RUN_ID}.json`);
const LATEST_FILE = path.join(RESULTS_DIR, "web-journeys-latest.json");

// "Remote" roughly matches a phone or laptop reaching Luna through Connect.
const REMOTE_NETWORK = {
  offline: false,
  latency: 80,
  downloadThroughput: (20 * 1024 * 1024) / 8,
  uploadThroughput: (5 * 1024 * 1024) / 8,
};

const TIMELINE_IMG = '[data-slot="photo-timeline"] img';
const FPS_TOLERANCE = 1;
/** A measure that starts this long after the spec's action lost its real start. */
const LATE_START_MS = 100;

/** @param {string[]} ids */
const wanted = (...ids) => !ONLY || ids.some((id) => ONLY.has(id));

/**
 * "driveId:path/in/drive" → parts. Empty when unset.
 * @param {string | undefined} value
 */
function drivePath(value) {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at <= 0) throw new Error(`Expected "driveId:path", got "${value}"`);
  return { drive: value.slice(0, at), path: value.slice(at + 1).replace(/^\/+|\/+$/g, "") };
}

/** @param {{ drive: string, path: string }} folder */
function folderUrl(folder) {
  return `/files/${encodeURIComponent(folder.drive)}${folder.path ? `?path=${encodeURIComponent(folder.path)}` : ""}`;
}

/** @param {number[]} sorted @param {number} p */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * p50/p95 of a list of durations and how p95 compares with `budgetMs`.
 * @param {number[]} samples
 * @param {number | undefined} budgetMs
 */
function stats(samples, budgetMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  return {
    runs: samples.length,
    samples_ms: samples.map(round),
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(p95),
    max_ms: round(sorted[sorted.length - 1] ?? null),
    budget_ms: budgetMs ?? null,
    within_budget: budgetMs == null || p95 == null ? null : p95 <= budgetMs,
  };
}

/** The time budget for a journey on the network profile this run uses. */
function budgetFor(id) {
  const j = BUDGETS.journeys[id] || {};
  return NETWORK === "remote" ? (j.remote_ms ?? j.lan_ms) : j.lan_ms;
}

function readResults() {
  if (existsSync(RESULTS_FILE)) return JSON.parse(readFileSync(RESULTS_FILE, "utf8"));
  return {
    run_id: RUN_ID,
    started_at: new Date().toISOString(),
    base_url: env.LUNA_PERF_BASE_URL || "http://127.0.0.1:8090",
    network: NETWORK,
    cpu_throttle: CPU_THROTTLE,
    runs: RUNS,
    reference_hardware: BUDGETS.reference_hardware,
    browser: null,
    journeys: {},
  };
}

/**
 * Merge one journey's result into this run's file (each journey writes as
 * soon as it finishes, so a failure later keeps what was measured).
 * @param {string} id
 * @param {object} result
 * @param {string} [browserVersion]
 */
function recordJourney(id, result, browserVersion) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const doc = readResults();
  if (browserVersion) doc.browser = browserVersion;
  doc.journeys[id] = { name: BUDGETS.journeys[id]?.name ?? id, ...result };
  doc.updated_at = new Date().toISOString();
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  writeFileSync(RESULTS_FILE, text);
  writeFileSync(LATEST_FILE, text);
  const r = doc.journeys[id];
  const verdict = r.skipped ? `skipped (${r.skipped})` : r.within_budget === false ? "OVER BUDGET" : r.within_budget ? "ok" : "";
  console.log(`[perf] ${id.padEnd(8)} p50=${r.p50_ms ?? "-"} p95=${r.p95_ms ?? "-"} budget=${r.budget_ms ?? "-"} ${verdict}`);
}

/**
 * A page with this run's CPU and network throttling. CDP emulation is per
 * page, so every page gets its own session.
 * @param {import("@playwright/test").BrowserContext} context
 */
async function openPage(context) {
  const page = await context.newPage();
  // Detailed mode turns on the timing points real users don't pay for (W8).
  await page.addInitScript(() => {
    /** @type {any} */ (window).__lunaPerfDetailed = true;
  });
  if (CPU_THROTTLE > 1 || NETWORK === "remote") {
    const cdp = await context.newCDPSession(page);
    if (CPU_THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
    if (NETWORK === "remote") {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", REMOTE_NETWORK);
    }
  }
  return page;
}

/** How many measures with this id the page has recorded so far. */
async function measureCount(page, id) {
  return page.evaluate((mid) => {
    const store = /** @type {any} */ (window).__lunaPerf;
    return store ? store.measures.filter((m) => m.id === mid).length : 0;
  }, id);
}

/**
 * Wait until the page records measure `id` number `after + 1`, then return
 * it with the long tasks that overlapped it. Null on timeout.
 * @param {import("@playwright/test").Page} page
 * @param {string} id
 * `actionAt` (page time of the action) flags a sample whose start came more
 * than LATE_START_MS later: the app replaced the real start, so the number
 * is too small. Callers count those as `late_starts`.
 * @param {{ after?: number, timeout?: number, actionAt?: number }} [options]
 */
async function waitMeasure(page, id, { after = 0, timeout = 60_000, actionAt = undefined } = {}) {
  try {
    await page.waitForFunction(
      ([mid, n]) => {
        const store = /** @type {any} */ (window).__lunaPerf;
        return Boolean(store) && store.measures.filter((m) => m.id === mid).length > n;
      },
      [id, after],
      { timeout, polling: 50 },
    );
  } catch {
    return null;
  }
  const sample = await page.evaluate((mid) => {
    const store = /** @type {any} */ (window).__lunaPerf;
    const all = store.measures.filter((m) => m.id === mid);
    const m = all[all.length - 1];
    const end = m.start + m.duration;
    const overlapping = store.longTasks.filter((t) => t.start < end && t.start + t.duration > m.start);
    return {
      duration: m.duration,
      start: m.start,
      long_tasks: overlapping.length,
      max_long_task_ms: overlapping.reduce((max, t) => Math.max(max, t.duration), 0),
      lcp_ms: store.lcp ? store.lcp.start : null,
    };
  }, id);
  return { ...sample, late: actionAt != null && sample.start - actionAt > LATE_START_MS };
}

/**
 * Start a journey from the spec, right before the action that begins it.
 * Returns the page time of the start (pass it as `actionAt`).
 */
async function startJourney(page, id) {
  return page.evaluate((mid) => {
    /** @type {any} */ (window).__lunaPerf?.start(mid);
    return performance.now();
  }, id);
}

/** Page time now, read right before an action the app times itself. */
async function pageNow(page) {
  return page.evaluate(() => performance.now());
}

/**
 * Client-side navigation without a reload, the way a link click does it
 * (React Router listens for popstate).
 * @param {import("@playwright/test").Page} page
 * @param {string} url
 */
async function spaNavigate(page, url) {
  await page.evaluate((to) => {
    const idx = (window.history.state?.idx ?? 0) + 1;
    window.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx }, "", to);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, url);
}

/** Load the Dashboard as a signed-in user and wait until it is usable. */
async function openDashboard(page) {
  await page.goto("/");
  const ready = await waitMeasure(page, "W1", { timeout: 120_000 });
  if (!ready) throw new Error("The Dashboard never became usable (no W1 measure). Is the session valid?");
}

/**
 * Sign in on /login. Returns the W3 sample.
 * @param {import("@playwright/test").Page} page
 */
async function signIn(page) {
  await page.goto("/login");
  const username = page.locator('input[name="username"]');
  await username.waitFor({ state: "visible", timeout: 60_000 });
  await username.fill(USER);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('form button[type="submit"]').first().click();
  const sample = await waitMeasure(page, "W3", { timeout: 60_000 });
  if (!sample) throw new Error("Sign-in did not reach the Dashboard. Check LUNA_PERF_USER / LUNA_PERF_PASSWORD (or wait out the sign-in limit).");
  return sample;
}

/** Saved session for every journey except W3 (one sign-in for the run). */
let storageState = null;

/** @param {import("@playwright/test").Browser} browser */
async function signedInState(browser) {
  if (storageState) return storageState;
  const context = await browser.newContext();
  const page = await openPage(context);
  await signIn(page);
  storageState = await context.storageState();
  await context.close();
  return storageState;
}

/**
 * Run `fn` once per run in a fresh signed-in context (cold HTTP cache).
 * @param {import("@playwright/test").Browser} browser
 * @param {number} runs
 * @param {(page: import("@playwright/test").Page, i: number) => Promise<void>} fn
 */
async function eachFreshContext(browser, runs, fn) {
  const state = await signedInState(browser);
  for (let i = 0; i < runs; i += 1) {
    const context = await browser.newContext({ storageState: state });
    try {
      await fn(await openPage(context), i);
    } finally {
      await context.close();
    }
  }
}

test.describe("Luna web journeys", () => {
  test.skip(!PASSWORD, "Set LUNA_PERF_PASSWORD (and LUNA_PERF_USER if not admin) to run the journeys.");

  test("W3 sign-in to Dashboard", async ({ browser }) => {
    test.skip(!wanted("W3"), "not selected");
    const samples = [];
    for (let i = 0; i < LOGIN_RUNS; i += 1) {
      const context = await browser.newContext();
      try {
        const page = await openPage(context);
        samples.push((await signIn(page)).duration);
        if (!storageState) storageState = await context.storageState();
      } finally {
        await context.close();
      }
    }
    recordJourney("W3", stats(samples, budgetFor("W3")), browser.version());
  });

  test("W1/W2 cold and warm load to Dashboard", async ({ browser }) => {
    test.skip(!wanted("W1", "W2"), "not selected");
    const cold = [];
    const warm = [];
    const lcpCold = [];
    const lcpWarm = [];
    await eachFreshContext(browser, RUNS, async (page) => {
      await page.goto("/");
      const first = await waitMeasure(page, "W1", { timeout: 120_000 });
      if (!first) throw new Error("No W1 measure: the Dashboard never became usable.");
      cold.push(first.duration);
      if (first.lcp_ms != null) lcpCold.push(first.lcp_ms);
      // A reload is a new document: the app records "W1" again, which is W2 here.
      await page.reload();
      const second = await waitMeasure(page, "W1", { timeout: 120_000 });
      if (second) {
        warm.push(second.duration);
        if (second.lcp_ms != null) lcpWarm.push(second.lcp_ms);
      }
    });
    if (wanted("W1")) recordJourney("W1", { ...stats(cold, budgetFor("W1")), lcp: stats(lcpCold) }, browser.version());
    if (wanted("W2")) recordJourney("W2", { ...stats(warm, budgetFor("W2")), lcp: stats(lcpWarm) });
  });

  test("W4/W5/W6 folders", async ({ browser }) => {
    const folders = [
      { id: "W4", folder: drivePath(env.LUNA_PERF_FOLDER_SMALL), env: "LUNA_PERF_FOLDER_SMALL" },
      { id: "W5", folder: drivePath(env.LUNA_PERF_FOLDER_LARGE), env: "LUNA_PERF_FOLDER_LARGE" },
    ];
    test.skip(!wanted("W4", "W5", "W6"), "not selected");
    for (const { id, folder, env: name } of folders) {
      if (!wanted(id)) continue;
      if (!folder) {
        recordJourney(id, { skipped: `set ${name}` });
        continue;
      }
      const samples = [];
      const longTasks = [];
      let late = 0;
      await eachFreshContext(browser, RUNS, async (page) => {
        // Land somewhere else first so the folder open is an in-app navigation.
        if (folder.path) {
          await page.goto(folderUrl({ drive: folder.drive, path: "" }));
          await waitMeasure(page, "W4", { timeout: 120_000 });
        } else {
          await openDashboard(page);
        }
        const before = await measureCount(page, "W4");
        const actionAt = await startJourney(page, "W4");
        await spaNavigate(page, folderUrl(folder));
        const sample = await waitMeasure(page, "W4", { after: before, actionAt });
        if (sample) {
          samples.push(sample.duration);
          longTasks.push(sample.max_long_task_ms);
          if (sample.late) late += 1;
        }
      });
      const budget = BUDGETS.journeys[id] || {};
      const maxLongTask = longTasks.length ? Math.max(...longTasks) : null;
      recordJourney(id, {
        ...stats(samples, budgetFor(id)),
        folder: `${folder.drive}:${folder.path}`,
        late_starts: late,
        max_long_task_ms: round(maxLongTask),
        max_long_task_budget_ms: budget.max_long_task_ms ?? null,
        long_task_within_budget:
          budget.max_long_task_ms == null || maxLongTask == null ? null : maxLongTask <= budget.max_long_task_ms,
      });
    }

    if (!wanted("W6")) return;
    const large = drivePath(env.LUNA_PERF_FOLDER_LARGE);
    if (!large) {
      recordJourney("W6", { skipped: "set LUNA_PERF_FOLDER_LARGE" });
      return;
    }
    const runs = [];
    await eachFreshContext(browser, SCROLL_RUNS, async (page) => {
      await page.goto(folderUrl(large));
      if (!(await waitMeasure(page, "W4", { timeout: 120_000 }))) return;
      runs.push(await page.evaluate(scrollEndToEnd, SCROLL_STEP_PX));
    });
    const budget = BUDGETS.journeys.W6 || {};
    const fps = runs.map((r) => r.fps);
    const maxFrame = runs.length ? Math.max(...runs.map((r) => r.max_frame_ms)) : null;
    const minFps = fps.length ? Math.min(...fps) : null;
    recordJourney("W6", {
      runs: runs.length,
      scroll_step_px: SCROLL_STEP_PX,
      fps: fps.map(round),
      min_fps: round(minFps),
      p95_frame_ms: round(runs.length ? Math.max(...runs.map((r) => r.p95_frame_ms)) : null),
      max_frame_ms: round(maxFrame),
      frames_over_50ms: runs.reduce((n, r) => n + r.slow_frames, 0),
      budget_min_fps: budget.min_fps ?? null,
      budget_max_frame_ms: budget.max_frame_ms ?? null,
      fps_tolerance: FPS_TOLERANCE,
      within_budget:
        minFps == null ? null : minFps >= (budget.min_fps ?? 0) - FPS_TOLERANCE && maxFrame <= (budget.max_frame_ms ?? Infinity),
    });
  });

  test("W7/W8/W9 photos", async ({ browser }) => {
    test.skip(!wanted("W7", "W8", "W9"), "not selected");
    const timeline = [];
    const scrub = [];
    const preview = [];
    const full = [];
    const late = { W7: 0, W9: 0 };
    let noPhotos = false;
    await eachFreshContext(browser, RUNS, async (page, i) => {
      if (noPhotos) return;
      await openDashboard(page);
      const actionAt = await startJourney(page, "W7");
      await spaNavigate(page, "/photos");
      const first = await waitMeasure(page, "W7", { timeout: 60_000, actionAt });
      if (!first) {
        noPhotos = (await page.locator(TIMELINE_IMG).count()) === 0;
        return;
      }
      timeline.push(first.duration);
      if (first.late) late.W7 += 1;

      // W8 approximation: no scrubber exists yet, so jump to the end of the
      // loaded timeline; the app times from the scroll coming to rest.
      if (wanted("W8")) {
        const before = await measureCount(page, "W8");
        await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
        const jump = await waitMeasure(page, "W8", { after: before, timeout: 30_000 });
        if (jump) scrub.push(jump.duration);
      }

      if (wanted("W9")) {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        const thumbs = page.locator(TIMELINE_IMG);
        const count = await thumbs.count();
        if (!count) return;
        const beforePreview = await measureCount(page, "W9");
        const beforeFull = await measureCount(page, "W9:full");
        // A different photo every run, so the full image is never cached.
        const clickAt = await pageNow(page);
        await thumbs.nth(i % count).click();
        const shown = await waitMeasure(page, "W9", { after: beforePreview, timeout: 30_000, actionAt: clickAt });
        const decoded = await waitMeasure(page, "W9:full", { after: beforeFull, timeout: 60_000 });
        if (shown) preview.push(shown.duration);
        if (shown?.late) late.W9 += 1;
        if (decoded) full.push(decoded.duration);
        await page.keyboard.press("Escape");
      }
    });
    if (noPhotos) {
      for (const id of ["W7", "W8", "W9"]) if (wanted(id)) recordJourney(id, { skipped: "no photos on this Luna" });
      return;
    }
    if (wanted("W7")) recordJourney("W7", { ...stats(timeline, budgetFor("W7")), late_starts: late.W7 }, browser.version());
    if (wanted("W8")) recordJourney("W8", { ...stats(scrub, budgetFor("W8")), note: "approximation: jump to the end of the loaded timeline" });
    if (wanted("W9")) {
      recordJourney("W9", {
        ...stats(preview, budgetFor("W9")),
        late_starts: late.W9,
        full: stats(full, BUDGETS.journeys.W9?.full_ms),
      });
    }
  });

  test("W10/W11 search", async ({ browser }) => {
    test.skip(!wanted("W10", "W11"), "not selected");
    const queries = [
      { id: "W10", text: env.LUNA_PERF_SEARCH_NAME, env: "LUNA_PERF_SEARCH_NAME" },
      { id: "W11", text: env.LUNA_PERF_SEARCH_MEANING, env: "LUNA_PERF_SEARCH_MEANING" },
    ];
    for (const { id, text, env: name } of queries) {
      if (!wanted(id)) continue;
      if (!text) {
        recordJourney(id, { skipped: `set ${name}` });
        continue;
      }
      const samples = [];
      const afterDebounce = [];
      let missed = 0;
      await eachFreshContext(browser, RUNS, async (page) => {
        await openDashboard(page);
        await page.evaluate(() => window.dispatchEvent(new Event("luna:open-file-search")));
        const box = page.locator('input[aria-label="Search for a file"]');
        await box.waitFor({ state: "visible" });
        const before = await measureCount(page, id);
        const beforeQuery = await measureCount(page, "W10:query");
        // One input event: the app times from this "keystroke".
        await box.fill(text);
        const sample = await waitMeasure(page, id, { after: before, timeout: 30_000 });
        if (!sample) {
          missed += 1;
          return;
        }
        samples.push(sample.duration);
        if (id === "W10") {
          const q = await waitMeasure(page, "W10:query", { after: beforeQuery, timeout: 5_000 });
          if (q) afterDebounce.push(q.duration);
        }
      });
      recordJourney(id, {
        ...stats(samples, budgetFor(id)),
        query: text,
        ...(id === "W10" ? { after_debounce: stats(afterDebounce) } : {}),
        ...(missed ? { missed_runs: missed, note: id === "W11" ? "no meaning or photo match in those runs" : "no results rendered" } : {}),
      });
    }
  });

  test("W12 office document", async ({ browser }) => {
    test.skip(!wanted("W12"), "not selected");
    const doc = drivePath(env.LUNA_PERF_OFFICE_DOC);
    if (!doc || !doc.path) {
      recordJourney("W12", { skipped: "set LUNA_PERF_OFFICE_DOC (and install the office pack)" });
      return;
    }
    const slash = doc.path.lastIndexOf("/");
    const folder = { drive: doc.drive, path: slash < 0 ? "" : doc.path.slice(0, slash) };
    const name = slash < 0 ? doc.path : doc.path.slice(slash + 1);
    const samples = [];
    let late = 0;
    await eachFreshContext(browser, OFFICE_RUNS, async (page) => {
      await page.goto(folderUrl(folder));
      await waitMeasure(page, "W4", { timeout: 120_000 });
      const before = await measureCount(page, "W12");
      const actionAt = await startJourney(page, "W12");
      const sep = folder.path ? "&" : "?";
      await spaNavigate(page, `${folderUrl(folder)}${sep}file=${encodeURIComponent(name)}`);
      const sample = await waitMeasure(page, "W12", { after: before, timeout: 180_000, actionAt });
      if (sample) samples.push(sample.duration);
      if (sample?.late) late += 1;
    });
    recordJourney("W12", { ...stats(samples, budgetFor("W12")), late_starts: late, document: `${doc.drive}:${doc.path}` });
  });

  test("W15 public share link", async ({ browser }) => {
    test.skip(!wanted("W15"), "not selected");
    const link = env.LUNA_PERF_SHARE;
    if (!link) {
      recordJourney("W15", { skipped: "set LUNA_PERF_SHARE (a /s/<token> link)" });
      return;
    }
    const url = link.startsWith("/s/") ? link : `/s/${link.replace(/^.*\/s\//, "")}`;
    const samples = [];
    const lcp = [];
    for (let i = 0; i < RUNS; i += 1) {
      // A guest: no session, cold cache.
      const context = await browser.newContext();
      try {
        const page = await openPage(context);
        await page.goto(url);
        const sample = await waitMeasure(page, "W15", { timeout: 60_000 });
        if (sample) {
          samples.push(sample.duration);
          if (sample.lcp_ms != null) lcp.push(sample.lcp_ms);
        }
      } finally {
        await context.close();
      }
    }
    recordJourney("W15", { ...stats(samples, budgetFor("W15")), lcp: stats(lcp) });
  });

  test("W16 page navigation", async ({ browser }) => {
    test.skip(!wanted("W16"), "not selected");
    const routes = ["/files", "/photos", "/settings", "/"];
    /** @type {Record<string, number[]>} */
    const byRoute = Object.fromEntries(routes.map((r) => [r, []]));
    const samples = [];
    let late = 0;
    const state = await signedInState(browser);
    const context = await browser.newContext({ storageState: state });
    try {
      const page = await openPage(context);
      await openDashboard(page);
      for (let i = 0; i < RUNS; i += 1) {
        for (const route of routes) {
          const before = await measureCount(page, "W16");
          const actionAt = await startJourney(page, "W16");
          await page
            .locator(`nav[aria-label="Primary"] a[href="${route}"]`)
            .filter({ visible: true })
            .first()
            .click();
          const sample = await waitMeasure(page, "W16", { after: before, timeout: 30_000, actionAt });
          if (sample) {
            samples.push(sample.duration);
            byRoute[route].push(sample.duration);
            if (sample.late) late += 1;
          }
          // Let the page's own data settle before the next click.
          await page.waitForTimeout(500);
        }
      }
    } finally {
      await context.close();
    }
    recordJourney("W16", {
      ...stats(samples, budgetFor("W16")),
      late_starts: late,
      by_route: Object.fromEntries(Object.entries(byRoute).map(([r, s]) => [r, stats(s)])),
    });
  });

  test.afterAll(() => {
    if (!existsSync(RESULTS_FILE)) return;
    console.log(`[perf] results: ${RESULTS_FILE}`);
  });
});

/**
 * Runs in the page: scroll the window from top to bottom a fixed step per
 * frame and sample frame times with requestAnimationFrame (W6).
 * @param {number} step
 */
async function scrollEndToEnd(step) {
  window.scrollTo(0, 0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const frames = [];
  const t0 = performance.now();
  let last = t0;
  const done = await new Promise((resolve) => {
    const tick = (t) => {
      frames.push(t - last);
      last = t;
      const bottom = document.documentElement.scrollHeight - window.innerHeight;
      if (window.scrollY >= bottom - 1 || t - t0 > 180_000) {
        resolve(t - t0);
        return;
      }
      window.scrollBy(0, step);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // The first delta includes the wait for the first frame.
  const deltas = frames.slice(1);
  const sorted = [...deltas].sort((a, b) => a - b);
  return {
    fps: deltas.length / (done / 1000),
    p95_frame_ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    max_frame_ms: sorted[sorted.length - 1] ?? 0,
    slow_frames: deltas.filter((d) => d > 50).length,
  };
}

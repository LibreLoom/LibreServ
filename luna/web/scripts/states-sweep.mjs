// State gallery *smoke* sweep: open every scenario in a real browser and
// record only what was actually observed — the page loaded with its fake, and
// there was no fake crash, unhandled error or missing-mock banner. It never
// executes a scenario's `check` items, so it must never write acceptance
// results: those live in testing/results.json and are recorded by a person
// through the gallery. This script writes testing/smoke-results.json instead.
//
// Run with the dev server up:
//   node scripts/states-sweep.mjs
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.STATES_URL || "http://127.0.0.1:3001";
const GALLERY = `${BASE}/__states`;
const OUT = path.resolve("testing/smoke-results.json");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STATES_CHROME ? { executablePath: process.env.STATES_CHROME } : {}),
});
// A fixed system colour scheme keeps a scenario with no declared theme
// deterministic: the app falls back to prefers-color-scheme when none is stored.
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme: "light",
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(GALLERY, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.__lunaFake, null, { timeout: 20000 });
const scenarios = await page.evaluate(async () => {
  const m = await import("/src/dev/scenarios/registry.js");
  return m.scenarios.map((s) => ({
    id: s.id,
    url: s.url || "/",
    check: s.check || [],
    realLunadOnly: s.realLunadOnly || "",
    viewport: s.viewport || "desktop",
    theme: s.theme || "", // empty means the scenario declares no theme
  }));
});
console.log(`smoke-sweeping ${scenarios.length} scenarios`);

// Vite HMR during a long sweep can reload the page mid-scenario. Those
// network-change/dynamic-import errors are harness artifacts, not app failures.
const isHarnessTransient = (message) =>
  /ERR_NETWORK_CHANGED|Failed to fetch dynamically imported module/i.test(String(message));

/** Theme storage is shared with the frame (same origin), so reset it per visit. */
async function resetTheme(theme) {
  await page.evaluate((value) => {
    try {
      if (value) localStorage.setItem("theme", value);
      else localStorage.removeItem("theme");
    } catch { /* storage blocked */ }
  }, theme);
}

/**
 * Open a scenario in a frame we can prove belongs to it. A hash assignment to
 * the value already in the address bar is a no-op (the gallery's hashchange
 * handler never fires), so a retry cannot reuse that: it reloads the gallery
 * document, which recreates the iframe from scratch. In both cases we wait for
 * the frame's fake (or its __mock src) to identify the exact scenario before
 * the visit is accepted — a stale frame must never count as a fresh retry.
 */
async function visitScenario(scenario, retry) {
  const encoded = encodeURIComponent(scenario.id);
  if (retry) {
    await page.evaluate((sid) => { window.location.hash = encodeURIComponent(sid); }, scenario.id);
    // page.goto with only a different hash is a same-document navigation; a
    // real reload is what guarantees a new iframe and a new boot of the fake.
    await page.reload({ waitUntil: "load" });
  } else {
    await page.evaluate((sid) => { window.location.hash = encodeURIComponent(sid); }, scenario.id);
  }
  await page.waitForFunction(({ sid, enc }) => {
    const f = document.querySelector("iframe");
    const w = f?.contentWindow;
    const c = w?.__lunaFake;
    if (!c || !w?.document?.body?.innerText) return false;
    // Wait until the app has actually applied a theme, not just installed the fake.
    if (!w.document.documentElement?.style?.colorScheme) return false;
    const snap = c.snapshot?.() || {};
    const fakeId = snap.scenarioId || snap.scenario?.id || c.scenario?.id || "";
    const fromSrc = (f.getAttribute("src") || "").includes(`__mock=${enc}`);
    return (!fakeId || fakeId === sid) && (!!fakeId || fromSrc);
  }, { sid: scenario.id, enc: encoded }, { timeout: 20000 });
}

const records = [];
let failures = 0;
for (let i = 0; i < scenarios.length; i++) {
  const scenario = scenarios[i];
  let status = "ok";
  let observed = [];
  // A failed visit never gets to claim a rendered theme or viewport.
  let rendered = { viewport: "unknown", theme: "unknown" };

  // A reload can break one visit; retry that scenario once before recording.
  for (let attempt = 0; attempt < 2; attempt++) {
    // Mark the whole visit window up front: errors thrown while the fresh
    // frame loads still belong to this attempt and must not be lost.
    const visitMark = { page: pageErrors.length, console: consoleErrors.length };
    // Baseline only moves forward once the new frame has identified the exact
    // scenario; until then every error from the visit window counts.
    let errBefore = visitMark;
    observed = [];
    status = "ok";
    try {
      await resetTheme(scenario.theme);
      await visitScenario(scenario, attempt === 1);
      errBefore = { page: pageErrors.length, console: consoleErrors.length };
      await page.waitForTimeout(200);
      const info = await page.evaluate(() => {
        const f = document.querySelector("iframe");
        const w = f.contentWindow;
        const snap = w.__lunaFake?.snapshot?.() || {};
        const text = w.document.body.innerText || "";
        const crashed = Array.isArray(snap.crashed) ? snap.crashed.length > 0 : !!snap.crashed;
        // Record what the frame renders, not what the scenario declares.
        const theme = w.document.documentElement.classList.contains("dark") ? "dark" : "light";
        let storedTheme = "";
        try { storedTheme = w.localStorage.getItem("theme") || ""; } catch { /* storage blocked */ }
        const { width } = f.getBoundingClientRect();
        // The gallery constrains frame height to its own viewport, so classify
        // by width (phone 390 / tablet 820 / desktop full) instead of height.
        const viewport = width <= 500 ? "phone" : width <= 900 ? "tablet" : "desktop";
        return {
          crashed,
          crashDetail: crashed ? JSON.stringify(snap.crashed).slice(0, 200) : "",
          unhandled: (snap.unhandled || []).length,
          banner: /No mock|no handler|not mocked|fake crashed/i.test(text),
          theme,
          storedTheme,
          viewport,
        };
      });
      rendered = { viewport: info.viewport, theme: info.theme };
      observed.push(`loaded ${scenario.url} in ${info.viewport}/${info.theme} with the fake installed`);
      if (scenario.theme !== info.theme) observed.push(`theme rendered ${info.theme} (stored ${info.storedTheme || "none"}, scenario declared ${scenario.theme || "default"})`);
      if (scenario.viewport !== info.viewport) observed.push(`viewport rendered ${info.viewport} (scenario declared ${scenario.viewport})`);
      if (info.crashed) { status = "problem"; observed.push(`fake crashed: ${info.crashDetail}`); }
      if (info.unhandled) { status = "problem"; observed.push(`${info.unhandled} unhandled error(s)`); }
      if (info.banner) { status = "problem"; observed.push("no-mock/crash banner in frame"); }
      if (status === "ok") observed.push("no fake crash, unhandled error or missing-mock banner");
    } catch (e) {
      status = "problem";
      observed.push(`harness: ${String(e).slice(0, 200)}`);
    }
    // Errors from the fresh load (visit mark → confirmed baseline) plus errors
    // after the baseline; load-time failures must stay in the record too.
    const newErrors = pageErrors.slice(visitMark.page, errBefore.page)
      .concat(consoleErrors.slice(visitMark.console, errBefore.console))
      .concat(pageErrors.slice(errBefore.page))
      .concat(consoleErrors.slice(errBefore.console))
      .filter((message) => !isHarnessTransient(message));
    if (newErrors.length) { status = "problem"; observed.push(newErrors.join(" | ").slice(0, 300)); }
    if (status === "ok" || attempt === 1) break;
    // Try once more after a short pause for Vite to settle.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  if (status === "problem") failures++;
  // The check items are recorded for context only. They are NOT asserted here.
  const checks = scenario.check.length ? ` Scenario check items (not asserted here): ${scenario.check.join(" | ")}.` : "";
  const caveat = scenario.realLunadOnly
    ? ` Needs real Luna: ${scenario.realLunadOnly.replace(/\.\s*$/, "")}.`
    : "";
  records.push({
    id: scenario.id,
    status,
    note: `Smoke observed: ${observed.join("; ")}.${checks}${caveat}`,
    at: new Date().toISOString(),
    viewport: rendered.viewport,
    theme: rendered.theme,
  });
  if (i % 40 === 0) console.log(`${i + 1}/${scenarios.length} ${scenario.id} ${status}`);
}

await browser.close();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  kind: "state-gallery-smoke-only",
  description: "Load-only smoke observations. NOT acceptance results: scenario check items were not executed. Acceptance status lives in results.json.",
  total: records.length,
  failures,
  records,
}, null, 2) + "\n");
console.log(`smoke sweep written to ${OUT}: ${records.length} scenarios, ${failures} problems`);
process.exit(failures ? 1 : 0);

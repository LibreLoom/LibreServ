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

// The gallery sizes its frame from each scenario's declared viewport (see
// Gallery.jsx VIEWPORTS): phone is a fixed 390px, tablet a fixed 820px, and
// desktop is 100% of the frame container. The browser itself must be wide
// enough for that container to honour those widths. At the old 1280px context
// both tablet and desktop frames collapsed to ~543px — below the app's 768px
// breakpoint — so a height-based label wrongly called them tablet/desktop while
// the app actually rendered the phone layout. `frame` is the target INNER width;
// `context` is the browser width that lets the gallery reach it.
const PRESETS = {
  phone: { frame: 390, context: 1280 },
  tablet: { frame: 820, context: 1700 },
  desktop: { frame: 1024, context: 1900 }, // desktop must clear the lg breakpoint to leave the tablet band
};
const PHONE_MAX = 768;
const DESKTOP_MIN = 1024;
/** Classify by the frame's real inner width, matching the app's Tailwind breakpoints. */
const classifyWidth = (w) => w < PHONE_MAX ? "phone" : w >= DESKTOP_MIN ? "desktop" : "tablet";
/** True when the frame actually rendered at the width its declared preset requires. */
const presetMatches = (preset, w) => {
  const target = PRESETS[preset]?.frame;
  if (!target) return false;
  return preset === "desktop" ? w >= target : Math.abs(w - target) <= 2;
};

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
let contextWidth = 1280; // matches the width the context was created with
for (let i = 0; i < scenarios.length; i++) {
  const scenario = scenarios[i];
  let status = "ok";
  let observed = [];
  // A failed visit never gets to claim a rendered theme or viewport.
  let rendered = { viewport: "unknown", theme: "unknown", frame: { innerWidth: null, innerHeight: null } };

  // Widen the gallery before visiting so its frame can honour the declared
  // preset. Context-level sizing survives the fresh-reload retry (page.reload),
  // unlike an inline style on the frame, which that reload would wipe.
  const preset = PRESETS[scenario.viewport] || PRESETS.desktop;
  if (preset.context !== contextWidth) {
    await page.setViewportSize({ width: preset.context, height: 900 });
    contextWidth = preset.context;
  }

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
        // Measure the frame's own viewport, not the gallery element's box: the
        // app's layout and media queries see these INNER dimensions.
        const innerWidth = w.innerWidth;
        const innerHeight = w.innerHeight;
        return {
          crashed,
          crashDetail: crashed ? JSON.stringify(snap.crashed).slice(0, 200) : "",
          unhandled: (snap.unhandled || []).length,
          banner: /No mock|no handler|not mocked|fake crashed/i.test(text),
          theme,
          storedTheme,
          innerWidth,
          innerHeight,
        };
      });
      // Classify by the frame's real inner width against the app's breakpoints
      // (phone < 768, tablet 768-1023, desktop >= 1024), not by element height.
      info.viewport = classifyWidth(info.innerWidth);
      info.frame = { innerWidth: info.innerWidth, innerHeight: info.innerHeight };
      rendered = { viewport: info.viewport, theme: info.theme, frame: info.frame };
      const widthOk = presetMatches(scenario.viewport, info.innerWidth);
      observed.push(`loaded ${scenario.url} in ${info.viewport}/${info.theme} (frame ${info.innerWidth}x${info.innerHeight}) with the fake installed`);
      if (scenario.theme !== info.theme) observed.push(`theme rendered ${info.theme} (stored ${info.storedTheme || "none"}, scenario declared ${scenario.theme || "default"})`);
      if (scenario.viewport !== info.viewport || !widthOk) {
        // Never silently record a mismatched label: the declared preset and the
        // width the app actually rendered must agree, or the visit is a problem.
        status = "problem";
        const expected = scenario.viewport === "desktop" ? ">= 1024" : `${PRESETS[scenario.viewport]?.frame ?? scenario.viewport}px`;
        observed.push(`viewport mismatch: frame inner ${info.innerWidth}x${info.innerHeight} rendered ${info.viewport}, scenario declared ${scenario.viewport} (expected ${expected})`);
      }
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
    // The frame's real inner dimensions, recorded next to the classification
    // so a future width regression is visible in the evidence.
    frame: rendered.frame,
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

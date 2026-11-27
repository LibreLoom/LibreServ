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
const OUT = path.resolve("testing/smoke-results.json");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STATES_CHROME ? { executablePath: process.env.STATES_CHROME } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

await page.goto(`${BASE}/__states`, { waitUntil: "load" });
await page.waitForFunction(() => document.querySelector("iframe")?.contentWindow?.__lunaFake, null, { timeout: 20000 });
const scenarios = await page.evaluate(async () => {
  const m = await import("/src/dev/scenarios/registry.js");
  return m.scenarios.map((s) => ({
    id: s.id,
    url: s.url || "/",
    check: s.check || [],
    realLunadOnly: s.realLunadOnly || "",
    viewport: s.viewport || "desktop",
    theme: s.theme || "scenario default",
  }));
});
console.log(`smoke-sweeping ${scenarios.length} scenarios`);

// Vite HMR during a long sweep can reload the page mid-scenario. Those
// network-change/dynamic-import errors are harness artifacts, not app failures.
const isHarnessTransient = (message) =>
  /ERR_NETWORK_CHANGED|Failed to fetch dynamically imported module/i.test(String(message));

const records = [];
let failures = 0;
for (let i = 0; i < scenarios.length; i++) {
  const scenario = scenarios[i];
  let status = "ok";
  let observed = [];

  // A reload can break one visit; retry that scenario once before recording.
  for (let attempt = 0; attempt < 2; attempt++) {
    const errBefore = { page: pageErrors.length, console: consoleErrors.length };
    observed = [];
    status = "ok";
    try {
      await page.evaluate((sid) => { window.location.hash = encodeURIComponent(sid); }, scenario.id);
      await page.waitForFunction((sid) => (document.querySelector("iframe")?.getAttribute("src") || "").includes(encodeURIComponent(sid)), scenario.id, { timeout: 20000 });
      await page.waitForFunction(() => {
        const f = document.querySelector("iframe");
        return !!f?.contentWindow?.__lunaFake && !!f?.contentWindow?.document?.body?.innerText;
      }, null, { timeout: 20000 });
      await page.waitForTimeout(200);
      const info = await page.evaluate(() => {
        const f = document.querySelector("iframe");
        const snap = f.contentWindow.__lunaFake?.snapshot?.() || {};
        const text = f.contentWindow.document.body.innerText || "";
        const crashed = Array.isArray(snap.crashed) ? snap.crashed.length > 0 : !!snap.crashed;
        return {
          crashed,
          crashDetail: crashed ? JSON.stringify(snap.crashed).slice(0, 200) : "",
          unhandled: (snap.unhandled || []).length,
          banner: /No mock|no handler|not mocked|fake crashed/i.test(text),
        };
      });
      observed.push(`loaded ${scenario.url} in ${scenario.viewport}/${scenario.theme} with the fake installed`);
      if (info.crashed) { status = "problem"; observed.push(`fake crashed: ${info.crashDetail}`); }
      if (info.unhandled) { status = "problem"; observed.push(`${info.unhandled} unhandled error(s)`); }
      if (info.banner) { status = "problem"; observed.push("no-mock/crash banner in frame"); }
      if (status === "ok") observed.push("no fake crash, unhandled error or missing-mock banner");
    } catch (e) {
      status = "problem";
      observed.push(`harness: ${String(e).slice(0, 200)}`);
    }
    const newErrors = pageErrors.slice(errBefore.page)
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
    viewport: scenario.viewport,
    theme: scenario.theme,
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

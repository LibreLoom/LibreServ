// State gallery sweep: open every scenario in a real browser, record what was
// actually observed, and post each result through the gallery's dev-server
// endpoint. Run with the dev server up:
//
//   node scripts/states-sweep.mjs
//
// The note written for each scenario includes that scenario's own `check`
// items and states exactly which assertions the sweep makes (page loads with
// its fake installed; no fake crash, unhandled error or missing-mock banner).
// Interaction-heavy check items are listed but are not claimed as asserted by
// the sweep — they are covered by the gallery's manual/audit record.
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.STATES_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true });
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
console.log(`sweeping ${scenarios.length} scenarios`);

async function post(id, result) {
  const res = await fetch(`${BASE}/__states/api/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, result }),
  });
  if (!res.ok) throw new Error(`POST ${id} -> ${res.status}`);
}

let failures = 0;
for (let i = 0; i < scenarios.length; i++) {
  const scenario = scenarios[i];
  const errBefore = { page: pageErrors.length, console: consoleErrors.length };
  let status = "pass";
  const observed = [];
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
    if (info.crashed) { status = "fail"; observed.push(`fake crashed: ${info.crashDetail}`); }
    if (info.unhandled) { status = "fail"; observed.push(`${info.unhandled} unhandled error(s)`); }
    if (info.banner) { status = "fail"; observed.push("no-mock/crash banner in frame"); }
    if (status === "pass") observed.push("no fake crash, unhandled error or missing-mock banner");
  } catch (e) {
    status = "fail";
    observed.push(`harness: ${String(e).slice(0, 200)}`);
  }
  const newErrors = pageErrors.slice(errBefore.page).concat(consoleErrors.slice(errBefore.console));
  if (newErrors.length) { status = "fail"; observed.push(newErrors.join(" | ").slice(0, 300)); }
  if (status === "fail") failures++;

  const checks = scenario.check.length ? ` Check items: ${scenario.check.join(" | ")}.` : "";
  // The fake cannot stand in for a real service (live collaboration, office
  // editors, real lunad routes). Say so explicitly instead of letting a
  // load-only pass read as if those flows were verified.
  const caveat = scenario.realLunadOnly
    ? ` Needs real Luna: ${scenario.realLunadOnly.replace(/\.\s*$/, "")}.`
    : "";
  const note = `Sweep observed: ${observed.join("; ")}.${checks}${caveat}`;
  await post(scenario.id, {
    status,
    note,
    at: new Date().toISOString(),
    viewport: scenario.viewport,
    theme: scenario.theme,
  });
  if (i % 40 === 0) console.log(`${i + 1}/${scenarios.length} ${scenario.id} ${status}`);
}

await browser.close();
console.log(`sweep done: ${scenarios.length} scenarios, ${failures} failures`);
process.exit(failures ? 1 : 0);

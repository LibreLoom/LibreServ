// Luna Connect page journeys C3 (onboarding cold load) and C4 (sign-in to the
// Luna page) in headless Chromium, with CPU and network throttling.
// See luna/perf/README.md → "Desktop and Connect".
//
//   node perf/clients/connect-pages.mjs            (env below; prints JSON)
//
// LUNA_CONNECT_URL / _EMAIL / _PASSWORD  Connect to measure and an account with a bound Luna
// C_RUNS (10)        samples per journey, each in a fresh browser context (cold cache)
// C_CPU (4)          Chrome CPU slowdown
// C_NET (4g)         4g: 9 Mbit/s down, 1.5 Mbit/s up, 150 ms RTT; slow4g: 1.6/0.75, 560 ms; none
// C_EDGE_GZIP (1)    put a gzip proxy in front, as Cloudflare compresses text in production
// C_OUT              write the JSON result here too
// C_DEBUG            print each sample's request timeline to stderr
import { createRequire } from "node:module";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../web/package.json"));
const { chromium } = require("playwright");

const env = process.env;
const origin = env.LUNA_CONNECT_URL || "http://127.0.0.1:8099";
const email = env.LUNA_CONNECT_EMAIL || "perf@example.test";
const password = env.LUNA_CONNECT_PASSWORD || "perf-connect-pass-1";
const runs = Number(env.C_RUNS || 10);
const cpu = Number(env.C_CPU || 4);
const netName = env.C_NET || "4g";
const nets = {
  "4g": { latency: 150, downloadThroughput: (9e6 / 8), uploadThroughput: (1.5e6 / 8) },
  slow4g: { latency: 562.5, downloadThroughput: (1.6e6 / 8), uploadThroughput: (750e3 / 8) },
  none: null,
};
const net = nets[netName];

// Cloudflare compresses text responses from the origin; Go's file server does not.
function edgeProxy() {
  const target = new URL(origin);
  const server = http.createServer((req, res) => {
    // Connect checks Origin against its own address, as the edge passes it through.
    const headers = { ...req.headers, host: target.host };
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) headers.referer = target.origin + new URL(headers.referer).pathname;
    const up = http.request(
      { host: target.hostname, port: target.port, path: req.url, method: req.method, headers },
      (r) => {
        const type = String(r.headers["content-type"] || "");
        const gz = /gzip/.test(String(req.headers["accept-encoding"] || "")) && !r.headers["content-encoding"] &&
          /text|javascript|json|css|svg|font\/ttf/.test(type);
        const headers = { ...r.headers };
        if (gz) {
          delete headers["content-length"];
          headers["content-encoding"] = "gzip";
        }
        res.writeHead(r.statusCode, headers);
        (gz ? r.pipe(zlib.createGzip()) : r).pipe(res);
      },
    );
    req.pipe(up);
    up.on("error", () => res.destroy());
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function context(browser) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  if (net) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...net });
  return { ctx, page };
}

const ready = (page, sel) =>
  page.waitForFunction(
    (s) => !!document.querySelector(s) && !document.body.innerText.includes("Loading..."),
    sel,
    { polling: "raf", timeout: 60000 },
  );

// C_DEBUG=1: print each request's start and end (ms since navigation) to stderr.
async function dumpTimeline(page, id) {
  const rows = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) =>
      [Math.round(e.startTime), Math.round(e.responseEnd), e.transferSize, e.name.replace(location.origin, "")]));
  console.error(id, JSON.stringify(rows));
}

async function c3(browser, base) {
  const { ctx, page } = await context(browser);
  const t0 = Date.now();
  await page.goto(`${base}/onboarding`, { waitUntil: "commit" });
  await ready(page, "main h1, main h2, h1, h2");
  const ms = Date.now() - t0;
  if (env.C_DEBUG) await dumpTimeline(page, "C3");
  const bytes = await page.evaluate(() =>
    performance.getEntriesByType("resource").reduce((n, e) => n + (e.transferSize || 0), 0) +
    (performance.getEntriesByType("navigation")[0]?.transferSize || 0));
  await ctx.close();
  return { ms, bytes };
}

async function c4(browser, base) {
  const { ctx, page } = await context(browser);
  await page.goto(`${base}/login`);
  await page.locator("#email").fill(email);
  await page.locator("input[type=password]").fill(password);
  const t0 = Date.now();
  await page.locator("form button[type=submit]").click({ noWaitAfter: true });
  await ready(page, "[data-testid=luna-hostname-hero]");
  const ms = Date.now() - t0;
  if (env.C_DEBUG) await dumpTimeline(page, "C4");
  // Sign out so the next sample signs in from scratch (and the rate limit sees few tries).
  await ctx.close();
  return { ms };
}

const stats = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const p = (q) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  return { n: v.length, p50: p(0.5), p95: p(0.95), max: v[v.length - 1] };
};

const proxy = env.C_EDGE_GZIP === "0" ? null : await edgeProxy();
const base = proxy ? `http://127.0.0.1:${proxy.address().port}` : origin;
const browser = await chromium.launch();
const out = { origin, edge_gzip: !!proxy, cpu, net: netName, journeys: {} };
for (const [id, fn, budget] of [["C3", c3, 1500], ["C4", c4, 1000]]) {
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(await fn(browser, base));
  out.journeys[id] = { ...stats(samples.map((s) => s.ms)), budget_ms: budget, samples: samples.map((s) => s.ms) };
  if (samples[0].bytes) out.journeys[id].transfer_bytes = samples[0].bytes;
}
await browser.close();
proxy?.close();
const json = JSON.stringify(out, null, 1);
if (env.C_OUT) fs.writeFileSync(env.C_OUT, json);
console.log(json);

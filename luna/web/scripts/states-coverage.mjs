// Lists every /api/v1 endpoint the web app calls and whether the fake Luna has a
// handler for it, plus scenario counts per area. Run: npm run states:coverage
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/dev/fake/handlers/index.js";
import { installFake } from "../src/dev/fake/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../src");

// Handler patterns come from a throwaway install against a stub window.
globalThis.window = { fetch: () => {}, location: { origin: "http://x" }, WebSocket: class {}, XMLHttpRequest: class {} };
const patterns = installFake({ world: { users: [] }, scenario: {}, now: 0 }).handlerPatterns()
  .map((p) => p.split(" ")[1])
  .map((p) => new RegExp(`^${p.replace(/:[A-Za-z_]+/g, "[^/]+")}$`));

const used = new Set();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "dev") walk(f); continue; }
    if (!/\.(js|jsx)$/.test(e.name) || /\.test\./.test(e.name)) continue;
    for (const m of fs.readFileSync(f, "utf8").matchAll(/["'`](\/api\/v1\/[A-Za-z0-9_\-/${}.]*)/g)) {
      used.add(m[1].replace(/\$\{[^}]*\}/g, "x").replace(/\/+$/, ""));
    }
  }
};
walk(src);

const missing = [...used].filter((u) => !patterns.some((re) => re.test(u))).sort();
console.log(`Endpoints the app calls: ${used.size}`);
console.log(`With a fake handler:      ${used.size - missing.length}`);
console.log(`Missing:                  ${missing.length}`);
for (const m of missing) console.log(`  ${m}`);

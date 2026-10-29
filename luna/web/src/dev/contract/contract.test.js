// Checks that the fake lunad (src/dev/fake) answers with the same JSON shapes as the real lunad.
// The real shapes come from lunad-responses.json, which a full ./ci run -profile luna writes (never edit it).
// A difference you accept goes in known-gaps.js with a reason; the failure message prints the line to paste.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../fake/handlers/index.js";
import { installFake } from "../fake/engine.js";
import { createWorld } from "../fake/world.js";
import { scenarios } from "../scenarios/registry.js";
import { CASES } from "./cases.js";
import { KNOWN_GAPS } from "./known-gaps.js";
import { compareShapes, mergeShapes, normalizeKey, parseFixtureShape, shapeOf, toFixtureJson } from "./shape.js";

const found = /** @type {any} */ (import.meta.glob("./lunad-responses.json", { eager: true, import: "default" }));
const fixture = found["./lunad-responses.json"];

/** @type {Map<string, any>} */
const realByKey = new Map();
/** @type {Map<string, string[]>} */
const methodsByPath = new Map();
for (const [k, v] of Object.entries(fixture || {})) {
  if (k.startsWith("$")) continue;
  const space = k.indexOf(" ");
  const method = k.slice(0, space);
  const key = normalizeKey(method, k.slice(space + 1));
  realByKey.set(key, v);
  const path = key.slice(method.length + 1);
  methodsByPath.set(path, [...(methodsByPath.get(path) || []), method]);
}

// Every route the fake registers, read from a throwaway install.
const originalFetch = window.fetch;
const probe = installFake({ world: createWorld(), scenario: {}, now: 0 });
/** @type {{ method: string, pattern: string }[]} */
const registered = /** @type {any[]} */ (probe.handlerPatterns()).map((p) => {
  if (typeof p === "string") { const i = p.indexOf(" "); return { method: p.slice(0, i), pattern: p.slice(i + 1) }; }
  return { method: p.method, pattern: p.pattern };
});
window.fetch = originalFetch;

/** Looks a case up by the registered pattern, tolerating different :param names. */
const caseFor = (id) => {
  if (CASES[id]) return CASES[id];
  const want = normalizeKey(...splitId(id));
  const hit = Object.keys(CASES).find((k) => normalizeKey(...splitId(k)) === want);
  return hit ? CASES[hit] : undefined;
};
function splitId(id) {
  const i = id.indexOf(" ");
  return /** @type {[string, string]} */ ([id.slice(0, i), id.slice(i + 1)]);
}

const routeIds = [...new Set([
  ...registered.filter((r) => r.method === "GET").map((r) => `${r.method} ${r.pattern}`),
  ...Object.keys(CASES).filter((id) => !id.startsWith("GET ")),
])].sort();

/** @type {Map<string, { shape: any, statuses: Set<string>, crashes: Set<string> }>} */
const fake = new Map();
/** @type {Set<string>} */
const weakSpots = new Set();
/** @type {Set<number>} */
const usedGaps = new Set();

beforeAll(async () => {
  if (!fixture) return;
  const worlds = [
    { name: "base", make: () => createWorld() },
    ...scenarios.map((s) => ({ name: s.id, make: () => createWorld(s.seed) })),
  ];
  for (const id of routeIds) fake.set(id, { shape: null, statuses: new Set(), crashes: new Set() });
  for (const w of worlds) {
    let world;
    try {
      world = w.make();
      window.fetch = originalFetch;
      installFake({ world, scenario: {}, now: 0 });
    } catch (err) {
      for (const rec of fake.values()) rec.crashes.add(`world ${w.name} did not build: ${err?.message || err}`);
      continue;
    }
    for (const id of routeIds) {
      const c = caseFor(id);
      const rec = /** @type {any} */ (fake.get(id));
      if (!c || "skip" in c) continue;
      try {
        c.prepare?.(world);
        const url = c.url(world);
        if (!url) continue;
        const [method] = splitId(id);
        const body = c.body ? JSON.stringify(c.body(world)) : undefined;
        const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body });
        rec.statuses.add(String(res.status));
        const text = await res.text();
        if (res.status >= 200 && res.status < 300 && text && /json/.test(res.headers.get("content-type") || "")) {
          const next = shapeOf(JSON.parse(text));
          rec.shape = rec.shape ? mergeShapes(rec.shape, next) : next;
        }
      } catch (err) {
        rec.crashes.add(`fake crashed: ${/** @type {any} */ (err)?.message || err}`);
      }
    }
  }
}, 120_000);

afterAll(() => {
  window.fetch = originalFetch;
  if (weakSpots.size) console.info(`contract: ${weakSpots.size} spots could not be checked (lunad only sent null or empty lists):\n  ${[...weakSpots].sort().join("\n  ")}`);
});

/** @param {string} id @returns {{ path: string, message: string }[]} */
function errorsFor(id) {
  const [method, pattern] = splitId(id);
  const key = normalizeKey(method, pattern);
  if (!realByKey.has(key)) {
    const others = methodsByPath.get(key.slice(method.length + 1)) || [];
    return [{ path: "*", message: `method mismatch: fake ${method}, lunad ${others.join(", ")}` }];
  }
  const rec = /** @type {any} */ (fake.get(id));
  if (!rec.shape) {
    const why = [...rec.crashes, `statuses: ${[...rec.statuses].sort().join(", ") || "none, no world had suitable data"}`].join("; ");
    return [{ path: "*", message: `fake never answered 200 (${why})` }];
  }
  const { errors, weak } = compareShapes(parseFixtureShape(realByKey.get(key)), rec.shape);
  for (const w of weak) weakSpots.add(`${key} ${w}`);
  return errors;
}

/** Drops accepted gaps (remembering which ones were used) and throws on what is left. */
function assertNoDrift(id, errors) {
  const key = normalizeKey(...splitId(id));
  const left = errors.filter((e) => {
    const at = KNOWN_GAPS.findIndex((g) => g.key === key && (g.path === e.path || g.path === "*"));
    if (at < 0) return true;
    usedGaps.add(at);
    return false;
  });
  if (!left.length) return;
  const lines = left.map((e) => `  ${e.path}: ${e.message}`);
  const paste = left.map((e) => `  { key: ${JSON.stringify(key)}, path: ${JSON.stringify(e.path)}, reason: "TODO" },`);
  throw new Error(`${id} differs from lunad:\n${lines.join("\n")}\nTo accept, paste into known-gaps.js:\n${paste.join("\n")}`);
}

describe("fake lunad matches lunad's response shapes", () => {
  if (!fixture) {
    it("has lunad's recorded shapes", () => {
      throw new Error("lunad-responses.json is missing: a full ./ci run -profile luna writes it");
    });
    return;
  }

  for (const id of routeIds) {
    const c = caseFor(id);
    if (!c) {
      it(id, () => { throw new Error(`add a CASES entry for ${id}`); });
      continue;
    }
    if ("skip" in c) {
      it.skip(`${id}: ${c.skip}`, () => {});
      continue;
    }
    const [method, pattern] = splitId(id);
    const key = normalizeKey(method, pattern);
    if (!realByKey.has(key) && !methodsByPath.has(key.slice(method.length + 1))) {
      it.todo(`${key}: no lunad test records this response yet`);
      continue;
    }
    it(id, () => assertNoDrift(id, errorsFor(id)));
  }

  it("every known gap still exists", () => {
    const stale = KNOWN_GAPS.filter((_, i) => !usedGaps.has(i));
    if (stale.length) {
      throw new Error(`These known gaps match nothing any more; remove them from known-gaps.js:\n${stale.map((g) => `  ${g.key} ${g.path}`).join("\n")}`);
    }
  });
});

describe("shape rules", () => {
  const samples = [[{ at: null, size: 1, mtime: 2 }], [], [{ at: 5, size: 1, mtime: 2, extra: "x" }]];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const fromFixture = (json) => parseFixtureShape(json);

  it("merging is order-independent", () => {
    const results = orders.map((o) => toFixtureJson(o.map((i) => shapeOf(samples[i])).reduce((a, b) => mergeShapes(a, b))));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]).toEqual([{ at: "null|number", "extra?": "string", mtime: "number", size: "number" }]);
  });

  it("reads and writes the fixture form", () => {
    const json = { $oneOf: ["null", { a: "boolean", "b?": ["string"] }] };
    expect(toFixtureJson(fromFixture(json))).toEqual(json);
  });

  it("a real shape of only null accepts anything and is weak", () => {
    const r = compareShapes(fromFixture("null"), shapeOf({ a: 1 }));
    expect(r.errors).toEqual([]);
    expect(r.weak).toEqual(["$"]);
  });

  it("an extra key fails", () => {
    const r = compareShapes(fromFixture({ a: "number" }), shapeOf({ a: 1, current: true }));
    expect(r.errors.map((e) => e.path)).toEqual(["$.current"]);
  });

  it("a missing required key fails, a missing optional one does not", () => {
    const real = fromFixture({ a: "number", mtime: "number", "opt?": "string" });
    expect(compareShapes(real, shapeOf({ a: 1 })).errors.map((e) => e.path)).toEqual(["$.mtime"]);
    expect(compareShapes(real, shapeOf({ a: 1, mtime: 2 })).errors).toEqual([]);
  });

  it("a key the fake only sometimes sends fails", () => {
    const fakeShape = mergeShapes(shapeOf({ a: 1, b: "x" }), shapeOf({ a: 1 }));
    const r = compareShapes(fromFixture({ a: "number", b: "string" }), fakeShape);
    expect(r.errors.map((e) => e.path)).toEqual(["$.b"]);
  });

  it("a wrong leaf type or object-versus-list fails", () => {
    expect(compareShapes(fromFixture({ a: "number" }), shapeOf({ a: "x" })).errors.map((e) => e.path)).toEqual(["$.a"]);
    expect(compareShapes(fromFixture({ a: "number" }), shapeOf([1])).errors.map((e) => e.path)).toEqual(["$"]);
  });

  it("an empty list on either side is weak", () => {
    const real = fromFixture([{ a: "number" }]);
    expect(compareShapes(real, shapeOf([])).weak).toEqual(["$[]"]);
    expect(compareShapes(fromFixture([]), shapeOf([{ a: 1 }])).weak).toEqual(["$[]"]);
  });

  it("the versions example differs at current and mtime", () => {
    const real = fromFixture([{ at: "null|number", mtime: "number", size: "number" }]);
    const fakeShape = shapeOf([{ at: 1, size: 2, current: true }, { at: 3, size: 4 }]);
    const paths = compareShapes(real, fakeShape).errors.map((e) => e.path).sort();
    expect(paths).toEqual(["$[].current", "$[].mtime"]);
  });

  it("normalizeKey treats axum and fake params alike", () => {
    expect(normalizeKey("GET", "/a/:id/b/:bid")).toBe(normalizeKey("GET", "/a/{drive_id}/b/{id}"));
    expect(normalizeKey("get", "/a/{*rest}")).toBe("GET /a/{*}");
  });
});

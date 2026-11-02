// Lists every /api/v1 call the web app makes and whether the fake Luna answers it —
// by METHOD and path, not just path. Run: npm run states:coverage
//
// It reads the source (no browser): calls through the api helpers (getJson, postJson, …),
// apiFetch / fetch with an explicit { method }, and URLs built through helper functions
// such as `base(driveId, id)` in components/files/backupsSource.js. A call whose URL it
// can't work out is listed as "unresolved" so nothing is silently skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/dev/fake/handlers/index.js";
import { handlerPatterns } from "../src/dev/fake/router.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../src");

const compile = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+")}$`);
const routes = handlerPatterns().map((r) => ({ ...r, re: compile(r.pattern) }));

const METHOD_OF = {
  getJson: "GET", getJsonAllowErrorStatus: "GET", getJsonSkipForbidden: "GET",
  postJson: "POST", postForm: "POST", postFormProgress: "POST",
  putJson: "PUT", putBinary: "PUT", putBinaryProgress: "PUT",
  patchJson: "PATCH", deleteJson: "DELETE",
};

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "dev") walk(f); continue; }
    if (/\.(js|jsx)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(f);
  }
};
walk(src);
const texts = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

// ── URL helpers: const name = (a, b) => `…/${a}/${b}`;  or  function name(a) { return `…`; }
/** Helpers are looked up in the file that uses them first (`base` means different things in different files). */
/** @type {Map<string, Map<string, { params: string[], tpl: string }>>} */
const perFile = new Map();
/** @type {Map<string, { params: string[], tpl: string }>} */
const everywhere = new Map();
let helpers = everywhere;
const helperRe = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*(`[^`]*`|"[^"]*"|'[^']*')|function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{\s*return\s+(`[^`]*`|"[^"]*"|'[^']*')/g;
const constRe = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(`[^`]*`|"[^"]*"|'[^']*')\s*;/g;
for (const [file, text] of texts) {
  const mine = new Map();
  perFile.set(file, mine);
  helpers = mine;
  for (const m of text.matchAll(helperRe)) {
    const name = m[1] || m[4];
    const params = (m[2] ?? m[5]).split(",").map((p) => p.trim().replace(/=.*$/, "").trim()).filter(Boolean);
    const tpl = m[3] || m[6];
    if (tpl.includes("/api/v1/") || tpl.includes("${")) helpers.set(name, { params, tpl: tpl.slice(1, -1) });
  }
  for (const m of text.matchAll(constRe)) {
    const tpl = m[2].slice(1, -1);
    if (tpl.startsWith("/api/v1/") || tpl.startsWith("/s/")) helpers.set(m[1], { params: [], tpl });
  }
  for (const [k, v] of mine) if (!everywhere.has(k)) everywhere.set(k, v);
}
const lookup = (name) => perFile.get(currentFile)?.get(name) ?? everywhere.get(name);
let currentFile = "";

/** Splits "a, b(c, d), e" on top-level commas. */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if ("([{`".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Turns an argument expression into a path template, or null when it can't. */
function resolve(expr, depth = 0) {
  if (depth > 4) return null;
  const e = expr.trim();
  if (/^`[\s\S]*`$/.test(e)) return expandTemplate(e.slice(1, -1), depth);
  if (/^("[^"]*"|'[^']*')$/.test(e)) return e.slice(1, -1);
  const call = /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(e);
  if (call && lookup(call[1])) return applyHelper(call[1], splitArgs(call[2]), depth);
  if (lookup(e) && lookup(e).params.length === 0) return lookup(e).tpl;
  return null;
}
function applyHelper(name, args, depth) {
  const h = lookup(name);
  let tpl = h.tpl;
  h.params.forEach((p, i) => { tpl = tpl.replace(new RegExp(`\\$\\{\\s*${p.replace("$", "\\$")}\\s*\\}`, "g"), `\${${args[i] ?? "x"}}`); });
  return expandTemplate(tpl, depth + 1);
}
function expandTemplate(tpl, depth) {
  return tpl.replace(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g, (whole, inner, at) => {
    const call = /^\s*([A-Za-z_$][\w$]*)\(([\s\S]*)\)\s*$/.exec(inner);
    if (call && lookup(call[1])) return applyHelper(call[1], splitArgs(call[2]), depth + 1) ?? "x";
    // A value glued onto a segment (".../run${query}") is a query string, not a path part.
    return at > 0 && tpl[at - 1] !== "/" ? "" : "x";
  });
}

/** @type {Map<string, { method: string, path: string, where: string }>} */
const calls = new Map();
const unresolved = [];
const methodNear = (text, from) => {
  const m = /method:\s*["'`]([A-Za-z]+)["'`]/.exec(text.slice(from, from + 260));
  return m ? m[1].toUpperCase() : "GET";
};
const record = (method, tpl, where) => {
  const clean = tpl.split("?")[0].replace(/\/+$/, "") || "/";
  if (!clean.startsWith("/api/v1/") && !clean.startsWith("/s/") && clean !== "/health") return;
  calls.set(`${method} ${clean}`, { method, path: clean, where });
};

for (const [file, text] of texts) {
  currentFile = file;
  const rel = path.relative(src, file);
  const callRe = /\b(getJsonSkipForbidden|getJsonAllowErrorStatus|getJson|postJson|postFormProgress|postForm|putJson|putBinaryProgress|putBinary|patchJson|deleteJson|apiFetch|fetch)\(\s*/g;
  for (const m of text.matchAll(callRe)) {
    const start = m.index + m[0].length;
    // The first argument: read up to the first top-level comma or the closing bracket.
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      const ch = text[end];
      if ("([{`".includes(ch)) depth += 1;
      if (")]}`".includes(ch)) { if (depth === 0) break; depth -= 1; }
      if (ch === "," && depth === 0) break;
    }
    const arg = text.slice(start, end);
    const method = METHOD_OF[m[1]] ?? methodNear(text, end);
    if (!/api\/v1|\/s\/|\/health|[a-z]/i.test(arg)) continue;
    const tpl = resolve(arg);
    if (tpl == null) {
      if (/\/api\/v1\//.test(arg)) unresolved.push(`${rel}: ${m[1]}(${arg.slice(0, 60)})`);
      continue;
    }
    record(method, tpl, rel);
  }
}

const matching = (c) => routes.find((r) => r.method === c.method && r.re.test(c.path));
const missing = [];
const wrongMethod = [];
for (const c of [...calls.values()].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method))) {
  if (matching(c)) continue;
  const others = routes.filter((r) => r.re.test(c.path)).map((r) => r.method);
  (others.length ? wrongMethod : missing).push({ ...c, others });
}

console.log(`Calls the app makes:      ${calls.size}`);
console.log(`Answered by the fake:     ${calls.size - missing.length - wrongMethod.length}`);
console.log(`Wrong method in the fake: ${wrongMethod.length}`);
console.log(`No handler at all:        ${missing.length}`);
for (const m of wrongMethod) console.log(`  ${m.method} ${m.path}  (the fake only has ${m.others.join(", ")})  ← ${m.where}`);
for (const m of missing) console.log(`  ${m.method} ${m.path}  ← ${m.where}`);
if (unresolved.length) {
  console.log(`Couldn't work out the address of ${unresolved.length} call(s):`);
  for (const u of unresolved) console.log(`  ${u}`);
}


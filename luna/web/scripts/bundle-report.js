// Bundle size report for luna/perf (W1/W2: what a first load downloads).
//
//   node scripts/bundle-report.js [distDir]        (npm run perf:bundle)
//   LUNA_BUNDLE_REPORT=1 npm run build             (runs after the build)
//
// Reads the built web app (default ../crates/lunad/web/dist), sorts every JS
// and CSS file into "initial" (index.html's entry, modulepreloads and
// stylesheets), "pages" (the per-route chunks) and "lazy" (everything else),
// and writes raw + gzip sizes to luna/perf/results/bundle-<time>.json and
// bundle-latest.json. No dependencies beyond Node.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(HERE, "../../crates/lunad/web/dist");
const RESULTS_DIR = path.resolve(HERE, "../../perf/results");
const PAGE_CHUNK = /^assets\/[A-Za-z]+Page-[\w-]+\.js$/;

/** @param {string} dir @returns {string[]} paths relative to `dir` */
function walk(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Files index.html loads before anything renders. @param {string} html */
function initialFiles(html) {
  const files = new Set();
  const re = /<(?:script|link)\b[^>]*?(?:src|href)="\/?([^"?#]+)"[^>]*>/g;
  for (const match of html.matchAll(re)) {
    const tag = match[0];
    const isEntry = tag.startsWith("<script") && /type="module"/.test(tag);
    const isPreload = /rel="(?:modulepreload|stylesheet)"/.test(tag);
    if (isEntry || isPreload) files.add(match[1]);
  }
  return files;
}

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

/**
 * @param {{ distDir?: string, resultsDir?: string, quiet?: boolean }} [options]
 */
export function writeBundleReport({ distDir = DEFAULT_DIST, resultsDir = RESULTS_DIR, quiet = false } = {}) {
  const indexHtml = path.join(distDir, "index.html");
  if (!existsSync(indexHtml)) throw new Error(`No build at ${distDir} (index.html missing). Run npm run build first.`);
  const initial = initialFiles(readFileSync(indexHtml, "utf8"));

  const files = walk(distDir)
    .filter((f) => /\.(?:js|css)$/.test(f))
    .map((file) => {
      const bytes = readFileSync(path.join(distDir, file));
      // A prebuilt .gz next to the file is what lunad would serve; else compress.
      const gz = existsSync(path.join(distDir, `${file}.gz`))
        ? statSync(path.join(distDir, `${file}.gz`)).size
        : gzipSync(bytes, { level: 9 }).length;
      const group = initial.has(file) ? "initial" : PAGE_CHUNK.test(file) ? "pages" : "lazy";
      return { file, group, bytes: bytes.length, gzip: gz };
    })
    .sort((a, b) => b.gzip - a.gzip);

  /** @param {string} group */
  const total = (group) => {
    const list = files.filter((f) => f.group === group);
    return { files: list.length, bytes: list.reduce((n, f) => n + f.bytes, 0), gzip: list.reduce((n, f) => n + f.gzip, 0) };
  };
  const report = {
    generated_at: new Date().toISOString(),
    dist: distDir,
    note: "initial = what index.html loads before the first page; pages = per-route chunks (one loads per first visit); lazy = editors, viewers and the rest.",
    totals: { initial: total("initial"), pages: total("pages"), lazy: total("lazy") },
    files,
  };

  mkdirSync(resultsDir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, "-");
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const out = path.join(resultsDir, `bundle-${stamp}.json`);
  writeFileSync(out, text);
  writeFileSync(path.join(resultsDir, "bundle-latest.json"), text);

  if (!quiet) {
    const t = report.totals;
    console.log(`Bundle (gzip KiB): initial ${kb(t.initial.gzip)} in ${t.initial.files} files, pages ${kb(t.pages.gzip)}, lazy ${kb(t.lazy.gzip)}`);
    for (const f of files.filter((x) => x.group !== "lazy")) {
      console.log(`  ${f.group.padEnd(7)} ${String(kb(f.gzip)).padStart(8)} KiB gz  ${String(kb(f.bytes)).padStart(8)} KiB  ${f.file}`);
    }
    console.log("  largest lazy chunks:");
    for (const f of files.filter((x) => x.group === "lazy").slice(0, 10)) {
      console.log(`  lazy    ${String(kb(f.gzip)).padStart(8)} KiB gz  ${String(kb(f.bytes)).padStart(8)} KiB  ${f.file}`);
    }
    console.log(`Report: ${out}`);
  }
  return report;
}

/**
 * Vite plugin: writes the report after `vite build` when LUNA_BUNDLE_REPORT=1,
 * reading the build's real outDir (the release tool builds elsewhere).
 * @returns {import("vite").Plugin}
 */
export function bundleReportPlugin() {
  let outDir = DEFAULT_DIST;
  return {
    name: "luna-bundle-report",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        if (process.env.LUNA_BUNDLE_REPORT !== "1") return;
        writeBundleReport({ distDir: outDir });
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writeBundleReport({ distDir: process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIST });
}

// Bundle size report for sol/perf (W1 asset size: entry JS, CSS and all
// shipped font faces). Font faces are an upper bound: the browser only
// downloads the ones the rendered page actually uses.
//
//   node scripts/bundle-report.js [distDir]        (npm run perf:bundle)
//   SOL_BUNDLE_REPORT=1 npm run build              (runs after the build)
//
// Reads the built web app (default ../backend/OS/dist), sorts every JS, CSS
// and font file into "initial" (index.html's entry, modulepreloads and
// stylesheets, plus the fonts those stylesheets request) and "lazy" (route
// chunks), and writes raw + gzip sizes to sol/perf/results/. No dependencies
// beyond Node.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(HERE, "../../backend/OS/dist");
const RESULTS_DIR = path.resolve(HERE, "../../../perf/results");
const FONT_RE = /\.(?:ttf|woff2?|otf)$/;

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

  // Fonts are referenced from CSS rather than index.html. A TTF next to a
  // WOFF2 is a fallback a modern browser never downloads: count only the
  // preferred face and leave the fallback out of every total.
  const all = walk(distDir);
  const fallbacks = new Set(
    all.filter((f) => /\.ttf$/.test(f) && all.includes(f.replace(/\.ttf$/, ".woff2"))),
  );
  for (const file of all) {
    if (!FONT_RE.test(file) || !file.startsWith("fonts/") || fallbacks.has(file)) continue;
    initial.add(file);
  }

  const files = all
    .filter((f) => /\.(?:js|css|ttf|woff2?|otf)$/.test(f) && !fallbacks.has(f))
    .map((file) => {
      const bytes = readFileSync(path.join(distDir, file));
      const gz = existsSync(path.join(distDir, `${file}.gz`))
        ? statSync(path.join(distDir, `${file}.gz`)).size
        : gzipSync(bytes, { level: 9 }).length;
      // What actually crosses the wire: the backend serves a .gz sibling for
      // JS/CSS when gzipAssets emitted one, and the raw file otherwise. Fonts
      // are never gzipped by that step.
      const hasGz = existsSync(path.join(distDir, `${file}.gz`));
      const wire = FONT_RE.test(file) || !hasGz ? bytes.length : gz;
      return { file, group: initial.has(file) ? "initial" : "lazy", bytes: bytes.length, gzip: gz, wire };
    })
    .sort((a, b) => b.bytes - a.bytes);

  /** @param {string} group */
  const total = (group) => {
    const list = files.filter((f) => f.group === group);
    return {
      files: list.length,
      bytes: list.reduce((n, f) => n + f.bytes, 0),
      gzip: list.reduce((n, f) => n + f.gzip, 0),
      wire: list.reduce((n, f) => n + f.wire, 0),
    };
  };
  const report = {
    generated_at: new Date().toISOString(),
    dist: distDir,
    note: "initial = entry JS, preloads, CSS and all shipped font faces; lazy = route chunks. A font face is only fetched when something uses it, so this is an upper bound on a real first load. 'wire' is what the server sends: .gz bytes for JS/CSS, raw bytes for fonts.",
    totals: { initial: total("initial"), lazy: total("lazy") },
    files,
  };

  mkdirSync(resultsDir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, "-");
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(path.join(resultsDir, `bundle-${stamp}.json`), text);
  writeFileSync(path.join(resultsDir, "bundle-latest.json"), text);

  if (!quiet) {
    const t = report.totals;
    console.log(`Bundle (upper bound: all shipped font faces): initial ${kb(t.initial.wire)} KiB on the wire / ${kb(t.initial.bytes)} KiB raw in ${t.initial.files} files; lazy ${kb(t.lazy.wire)} KiB on the wire`);
    for (const f of files.filter((x) => x.group === "initial")) {
      console.log(`  initial ${String(kb(f.bytes)).padStart(8)} KiB raw  ${String(kb(f.gzip)).padStart(8)} KiB gz  ${f.file}`);
    }
    console.log("  largest lazy chunks:");
    for (const f of files.filter((x) => x.group === "lazy").slice(0, 10)) {
      console.log(`  lazy    ${String(kb(f.bytes)).padStart(8)} KiB raw  ${String(kb(f.gzip)).padStart(8)} KiB gz  ${f.file}`);
    }
  }
  return report;
}

/**
 * Vite plugin: writes the report after `vite build` when SOL_BUNDLE_REPORT=1.
 * @returns {import("vite").Plugin}
 */
export function bundleReportPlugin() {
  let outDir = DEFAULT_DIST;
  return {
    name: "sol-bundle-report",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: "post",
      handler() {
        if (process.env.SOL_BUNDLE_REPORT !== "1") return;
        writeBundleReport({ distDir: outDir, quiet: true });
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writeBundleReport({ distDir: process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIST });
}

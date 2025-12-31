#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ALLOWED_KEYWORDS = new Set([
  "currentcolor",
  "transparent",
  "inherit",
  "initial",
  "unset",
]);

const COLOR_KEYWORDS = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
];

const EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".html",
  ".svg",
]);

const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const DEFAULT_IGNORED_SVG_DIRS = new Set(["assets", "public"]);

const hexRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const rgbRe = /\brgba?\(\s*[^)]*\)/g;
const hslRe = /\bhsla?\(\s*[^)]*\)/g;
const keywordRe = new RegExp(
  `(?:^|[^a-zA-Z-])(${COLOR_KEYWORDS.join("|")})(?=$|[^a-zA-Z-])`,
  "gi",
);

const wantsJson = process.argv.includes("--json");
const inputPaths = process.argv.slice(2).filter((arg) => arg !== "--json");

const defaultRoots = (() => {
  const cwd = process.cwd();
  const repoRoots = [
    path.join(cwd, "server", "frontend", "src"),
    path.join(cwd, "server", "frontend", "public"),
  ];
  const localRoots = [path.join(cwd, "src"), path.join(cwd, "public")];
  const repoExists = repoRoots.some((p) => fs.existsSync(p));
  return repoExists ? repoRoots : localRoots;
})();

const roots = inputPaths.length > 0 ? inputPaths : defaultRoots;

function walkDir(dirPath, files) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else if (entry.isFile()) {
      if (EXTENSIONS.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }
}

function shouldIgnoreFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") {
    const segments = filePath.split(path.sep);
    for (const segment of segments) {
      if (DEFAULT_IGNORED_SVG_DIRS.has(segment)) {
        return true;
      }
    }
  }
  return false;
}

function recordMatch(results, filePath, lineNumber, column, match, lineText) {
  results.push({
    file: filePath,
    line: lineNumber,
    column,
    match,
    lineText: lineText.trim(),
  });
}

function shouldIgnoreLine(filePath, lineText) {
  const ext = path.extname(filePath).toLowerCase();
  if (
    ext === ".css" ||
    ext === ".scss" ||
    ext === ".sass" ||
    ext === ".less" ||
    ext === ".styl"
  ) {
    if (/^\s*--palette-[a-z0-9-]+\s*:/.test(lineText)) {
      return true;
    }
    if (/^\s*--color-(primary|secondary|accent)\s*:/.test(lineText)) {
      return true;
    }
  }
  if (ext === ".svg") {
    if (/\b(pagecolor|bordercolor|inkscape:deskcolor)\s*=/.test(lineText)) {
      return true;
    }
  }
  return false;
}

function scanLine(results, filePath, lineNumber, lineText) {
  if (shouldIgnoreLine(filePath, lineText)) {
    return;
  }
  let match;
  hexRe.lastIndex = 0;
  rgbRe.lastIndex = 0;
  hslRe.lastIndex = 0;
  keywordRe.lastIndex = 0;
  while ((match = hexRe.exec(lineText)) !== null) {
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
    );
  }
  while ((match = rgbRe.exec(lineText)) !== null) {
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
    );
  }
  while ((match = hslRe.exec(lineText)) !== null) {
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
    );
  }
  while ((match = keywordRe.exec(lineText)) !== null) {
    const keyword = match[1].toLowerCase();
    if (ALLOWED_KEYWORDS.has(keyword)) {
      continue;
    }
    const keywordIndex = match.index + match[0].indexOf(match[1]);
    recordMatch(
      results,
      filePath,
      lineNumber,
      keywordIndex + 1,
      match[1],
      lineText,
    );
  }
}

function scanFile(filePath) {
  if (shouldIgnoreFile(filePath)) {
    return [];
  }
  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);
  const results = [];
  for (let i = 0; i < lines.length; i += 1) {
    scanLine(results, filePath, i + 1, lines[i]);
  }
  return results;
}

function formatResults(results) {
  if (wantsJson) {
    return JSON.stringify(results, null, 2);
  }
  if (results.length === 0) {
    return "No hardcoded colors found.";
  }
  return results
    .map((item) => {
      return `${item.file}:${item.line}:${item.column} ${item.match} ${item.lineText}`;
    })
    .join("\n");
}

function main() {
  const files = [];
  for (const root of roots) {
    walkDir(path.resolve(root), files);
  }
  const results = [];
  for (const filePath of files) {
    results.push(...scanFile(filePath));
  }
  console.log(formatResults(results));
  process.exit(results.length === 0 ? 0 : 1);
}

main();

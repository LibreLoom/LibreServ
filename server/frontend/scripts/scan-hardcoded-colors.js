#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const ALLOWED_KEYWORDS = new Set([
  "currentcolor",
  "transparent",
  "inherit",
  "initial",
  "unset",
  "none",
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

const TAILWIND_COLOR_NAMES = new Set([
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "black",
  "white",
]);

const TAILWIND_NO_SHADE = new Set(["black", "white"]);

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
  ".json",
  ".yml",
  ".yaml",
]);

const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const DEFAULT_IGNORED_SVG_DIRS = new Set(["assets", "public"]);

const hexRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const rgbRe = /\brgba?\(\s*[^)]*\)/g;
const hslRe = /\bhsla?\(\s*[^)]*\)/g;
const colorFnRe = /\b(?:lab|lch|oklab|oklch|color|color-mix)\(\s*[^)]*\)/g;
const keywordRe = new RegExp(
  `(?:^|[^a-zA-Z-])(${COLOR_KEYWORDS.join("|")})(?=$|[^a-zA-Z-])`,
  "gi",
);
const tailwindUtilityRe =
  /\b(?:bg|text|border|outline|ring|ring-offset|divide|fill|stroke|from|via|to|accent|caret|placeholder|decoration|shadow)-([a-z]+)(?:-([0-9]{2,3}))?(?:\/[0-9]{1,3})?\b/g;
const tailwindArbitraryRe =
  /\b(?:bg|text|border|outline|ring|ring-offset|divide|fill|stroke|from|via|to|accent|caret|placeholder|decoration|shadow)-\[(.+?)\]\b/g;

const hexTestRe = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/i;
const rgbTestRe = /\brgba?\(\s*[^)]*\)/i;
const hslTestRe = /\bhsla?\(\s*[^)]*\)/i;
const colorFnTestRe = /\b(?:lab|lch|oklab|oklch|color|color-mix)\(\s*[^)]*\)/i;
const keywordTestRe = new RegExp(
  `(?:^|[^a-zA-Z-])(${COLOR_KEYWORDS.join("|")})(?=$|[^a-zA-Z-])`,
  "i",
);
const tailwindThemeTestRe = /\btheme\(\s*[^)]*\)/i;
const tailwindThemeRe = /\btheme\(\s*[^)]*\)/g;
const cssVarTestRe = /\bvar\(\s*--/i;
const applyRe = /@apply\s+([^;]+);?/g;
const jsxStyleRe = /\bstyle=\{\{([^}]+)\}\}/g;
const htmlStyleRe = /\bstyle\s*=\s*"([^"]+)"/g;
const svgAttrRe =
  /\b(?:fill|stroke|stop-color|flood-color|lighting-color)\s*=\s*["']([^"']+)["']/g;
const cssVarAssignRe = /--[a-zA-Z0-9-_]+\s*:\s*([^;]+);?/g;
const configColorKeyRe =
  /\b(?:color|colors|bg|background|border|text|fill|stroke|outline|accent|primary|secondary|error|danger|warning|success)\b\s*[:=]\s*([^,}\n]+)/gi;

// Regex for detecting comments
const cssCommentRe = /\/\*[\s\S]*?\*\//g;
const jsCommentRe = /\/\/.*$/gm;

// Regex for detecting black/white with alpha (warnings only)
const blackWhiteAlphaRe =
  /\brgba?\(\s*(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)\s*,\s*[\d.]+\s*\)/gi;

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

function recordMatch(
  results,
  filePath,
  lineNumber,
  column,
  match,
  lineText,
  isWarning = false,
  allLines = [],
) {
  // Get context lines (1 before, 1 after)
  const contextBefore =
    lineNumber > 1 && allLines[lineNumber - 2]
      ? allLines[lineNumber - 2].trim()
      : null;
  const contextAfter = allLines[lineNumber]
    ? allLines[lineNumber].trim()
    : null;

  results.push({
    file: filePath,
    line: lineNumber,
    column,
    match,
    lineText: lineText.trim(),
    isWarning,
    contextBefore,
    contextAfter,
  });
}

function stripComments(lineText, ext) {
  let result = lineText;

  // Strip CSS-style comments
  if ([".css", ".scss", ".sass", ".less", ".styl"].includes(ext)) {
    result = result.replace(cssCommentRe, "");
  }

  // Strip JS-style comments
  if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
    result = result.replace(cssCommentRe, ""); // Block comments
    result = result.replace(jsCommentRe, ""); // Line comments
  }

  return result;
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

function scanLine(results, filePath, lineNumber, lineText, allLines) {
  if (shouldIgnoreLine(filePath, lineText)) {
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const strippedLine = stripComments(lineText, ext);

  // If the entire line was a comment, skip it
  if (strippedLine.trim().length === 0 && lineText.trim().length > 0) {
    return;
  }

  let match;
  hexRe.lastIndex = 0;
  rgbRe.lastIndex = 0;
  hslRe.lastIndex = 0;
  colorFnRe.lastIndex = 0;
  keywordRe.lastIndex = 0;
  blackWhiteAlphaRe.lastIndex = 0;
  tailwindThemeRe.lastIndex = 0;
  applyRe.lastIndex = 0;
  tailwindUtilityRe.lastIndex = 0;
  tailwindArbitraryRe.lastIndex = 0;
  jsxStyleRe.lastIndex = 0;
  htmlStyleRe.lastIndex = 0;
  svgAttrRe.lastIndex = 0;
  cssVarAssignRe.lastIndex = 0;
  configColorKeyRe.lastIndex = 0;

  // Check for black/white with alpha (warning only)
  const warningMatches = new Set();
  while ((match = blackWhiteAlphaRe.exec(strippedLine)) !== null) {
    warningMatches.add(match.index);
  }

  blackWhiteAlphaRe.lastIndex = 0;
  while ((match = hexRe.exec(strippedLine)) !== null) {
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = rgbRe.exec(strippedLine)) !== null) {
    const isWarning = warningMatches.has(match.index);
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      isWarning,
      allLines,
    );
  }
  while ((match = hslRe.exec(strippedLine)) !== null) {
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = colorFnRe.exec(strippedLine)) !== null) {
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = tailwindThemeRe.exec(strippedLine)) !== null) {
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = applyRe.exec(strippedLine)) !== null) {
    const classes = match[1] ?? "";
    const classMatches = classes.match(tailwindUtilityRe);
    if (classMatches && classMatches.length > 0) {
      recordMatch(
        results,
        filePath,
        lineNumber,
        match.index + 1,
        match[0],
        lineText,
        false,
        allLines,
      );
    }
    if (tailwindArbitraryRe.test(classes)) {
      recordMatch(
        results,
        filePath,
        lineNumber,
        match.index + 1,
        match[0],
        lineText,
        false,
        allLines,
      );
    }
  }
  while ((match = jsxStyleRe.exec(strippedLine)) !== null) {
    const styleBody = match[1] ?? "";
    if (!hasHardcodedColorValue(styleBody)) {
      continue;
    }
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = htmlStyleRe.exec(strippedLine)) !== null) {
    const styleBody = match[1] ?? "";
    if (!hasHardcodedColorValue(styleBody)) {
      continue;
    }
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = tailwindUtilityRe.exec(strippedLine)) !== null) {
    const colorName = match[1]?.toLowerCase();
    const shade = match[2];
    if (!TAILWIND_COLOR_NAMES.has(colorName)) {
      continue;
    }
    if (!shade && !TAILWIND_NO_SHADE.has(colorName)) {
      continue;
    }
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = tailwindArbitraryRe.exec(strippedLine)) !== null) {
    const value = match[1] ?? "";
    if (!hasHardcodedColorValue(value)) {
      continue;
    }
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  while ((match = svgAttrRe.exec(strippedLine)) !== null) {
    const value = match[1] ?? "";
    if (!hasHardcodedColorValue(value)) {
      continue;
    }
    recordMatch(
      results,
      filePath,
      lineNumber,
      match.index + 1,
      match[0],
      lineText,
      false,
      allLines,
    );
  }
  if ([".css", ".scss", ".sass", ".less", ".styl"].includes(ext)) {
    while ((match = cssVarAssignRe.exec(strippedLine)) !== null) {
      const value = match[1] ?? "";
      if (!hasHardcodedColorValue(value)) {
        continue;
      }
      recordMatch(
        results,
        filePath,
        lineNumber,
        match.index + 1,
        match[0],
        lineText,
        false,
        allLines,
      );
    }
  }
  if ([".json", ".yml", ".yaml"].includes(ext)) {
    while ((match = configColorKeyRe.exec(strippedLine)) !== null) {
      const value = match[1] ?? "";
      if (!hasHardcodedColorValue(value)) {
        continue;
      }
      recordMatch(
        results,
        filePath,
        lineNumber,
        match.index + 1,
        match[0],
        lineText,
        false,
        allLines,
      );
    }
  }
  while ((match = keywordRe.exec(strippedLine)) !== null) {
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
      false,
      allLines,
    );
  }
}

function hasHardcodedColorValue(value) {
  if (!value) return false;

  if (hexTestRe.test(value)) return true;
  if (rgbTestRe.test(value)) return true;
  if (hslTestRe.test(value)) return true;
  if (colorFnTestRe.test(value)) return true;
  if (tailwindThemeTestRe.test(value)) return true;

  if (cssVarTestRe.test(value)) {
    return false;
  }

  const keywordMatch = value.match(keywordTestRe);
  if (keywordMatch) {
    const keyword = keywordMatch[1].toLowerCase();
    if (!ALLOWED_KEYWORDS.has(keyword)) {
      return true;
    }
  }

  return false;
}

async function scanFile(filePath) {
  if (shouldIgnoreFile(filePath)) {
    return [];
  }

  const results = [];
  const lines = [];

  // Stream file line by line to avoid loading entire file into memory
  const fileStream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines.push(line);
  }

  // Now scan all lines with full context
  for (let i = 0; i < lines.length; i += 1) {
    scanLine(results, filePath, i + 1, lines[i], lines);
  }

  return results;
}

function formatResults(results) {
  if (wantsJson) {
    return JSON.stringify(results, null, 2);
  }

  const errors = results.filter((r) => !r.isWarning);
  const warnings = results.filter((r) => r.isWarning);

  if (results.length === 0) {
    return "No hardcoded colors found.";
  }

  const output = [];

  if (errors.length > 0) {
    output.push("ERRORS:");
    errors.forEach((item) => {
      output.push(`${item.file}:${item.line}:${item.column}`);
      if (item.contextBefore) {
        output.push(`  ${item.line - 1} | ${item.contextBefore}`);
      }
      output.push(`> ${item.line} | ${item.lineText}`);
      output.push(
        `  ${" ".repeat(String(item.line).length)} | ${" ".repeat(item.column - 1)}^ ${item.match}`,
      );
      if (item.contextAfter) {
        output.push(`  ${item.line + 1} | ${item.contextAfter}`);
      }
      output.push("");
    });
  }

  if (warnings.length > 0) {
    output.push(
      "WARNINGS (black/white with alpha - consider using semantic colors):",
    );
    warnings.forEach((item) => {
      output.push(`${item.file}:${item.line}:${item.column}`);
      if (item.contextBefore) {
        output.push(`  ${item.line - 1} | ${item.contextBefore}`);
      }
      output.push(`> ${item.line} | ${item.lineText}`);
      output.push(
        `  ${" ".repeat(String(item.line).length)} | ${" ".repeat(item.column - 1)}^ ${item.match}`,
      );
      if (item.contextAfter) {
        output.push(`  ${item.line + 1} | ${item.contextAfter}`);
      }
      output.push("");
    });
  }

  return output.join("\n");
}

async function main() {
  const files = [];
  for (const root of roots) {
    walkDir(path.resolve(root), files);
  }
  const results = [];
  for (const filePath of files) {
    const fileResults = await scanFile(filePath);
    results.push(...fileResults);
  }
  console.log(formatResults(results));

  // Exit with error only if there are actual errors (not warnings)
  const hasErrors = results.some((r) => !r.isWarning);
  process.exit(hasErrors ? 1 : 0);
}

main();

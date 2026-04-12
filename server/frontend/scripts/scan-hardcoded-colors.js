#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Keywords that are safe to leave as-is (not "hardcoded colors").
const ALLOWED_KEYWORDS = new Set([
  "currentcolor",
  "transparent",
  "inherit",
  "initial",
  "unset",
  "none",
]);

// Named colors that might appear in CSS or SVG attributes.
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

// Tailwind colors that don't use numeric shades.
const TAILWIND_NO_SHADE = new Set(["black", "white"]);

// File types we scan for hardcoded color values.
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
const classAttrMultilineRe = /\bclass(?:Name)?\s*=\s*"([\s\S]*?)"/g;
const classNameTemplateRe = /\bclassName\s*=\s*\{\s*`([\s\S]*?)`\s*\}/g;
const twAttrMultilineRe = /\btw\s*=\s*"([\s\S]*?)"/g;
const twAttrTemplateRe = /\btw\s*=\s*\{\s*`([\s\S]*?)`\s*\}/g;
const applyMultilineRe = /@apply\s+([\s\S]*?);/g;
const styleAttrMultilineRe = /\bstyle\s*=\s*"([\s\S]*?)"/g;
const svgStyleBlockRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const jsColorKeyRe =
  /\b(?:color|colors|bg|background|border|text|fill|stroke|outline|accent|primary|secondary|error|danger|warning|success)\b\s*:\s*([`'"][^`'"]+[`'"])/gi;
const cssPropertyRe =
  /\b(?:color|background|background-color|border-color|outline-color|fill|stroke|caret-color|accent-color|text-decoration-color)\s*:\s*([^;]+);/gi;
const cssAtPropertyRe = /@property\s+--[a-zA-Z0-9-_]+/gi;
const cssAtPropertyInitialValueRe = /\binitial-value\s*:\s*([^;]+);/gi;
const filterColorRe = /\b(?:filter|drop-shadow)\s*:\s*([^;]+);/gi;
const directiveRe =
  /color-scan:\s*(ignore-next-line|ignore-line|ignore-file)(?:\s+(.+))?/i;

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

function getLineInfoFromIndex(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid];
    const nextLineStart =
      mid + 1 < lineStarts.length
        ? lineStarts[mid + 1]
        : Number.POSITIVE_INFINITY;

    if (index >= lineStart && index < nextLineStart) {
      return { line: mid + 1, column: index - lineStart + 1 };
    }

    if (index < lineStart) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return { line: 1, column: 1 };
}

function extractTailwindColorClasses(value) {
  if (!value) return [];
  const matches = [];
  const utilityRe = new RegExp(tailwindUtilityRe.source, "g");
  const arbitraryRe = new RegExp(tailwindArbitraryRe.source, "g");
  let match;

  while ((match = utilityRe.exec(value)) !== null) {
    const colorName = match[1]?.toLowerCase();
    const shade = match[2];
    if (!TAILWIND_COLOR_NAMES.has(colorName)) {
      continue;
    }
    if (!shade && !TAILWIND_NO_SHADE.has(colorName)) {
      continue;
    }
    matches.push(match[0]);
  }

  while ((match = arbitraryRe.exec(value)) !== null) {
    const arbitraryValue = match[1] ?? "";
    if (!hasHardcodedColorValue(arbitraryValue)) {
      continue;
    }
    matches.push(match[0]);
  }

  return matches;
}

function scanTextForColors({
  text,
  filePath,
  lines,
  lineStarts,
  suppressedLines,
}) {
  const results = [];
  const textHexRe = new RegExp(hexRe.source, "g");
  const textRgbRe = new RegExp(rgbRe.source, "g");
  const textHslRe = new RegExp(hslRe.source, "g");
  const textColorFnRe = new RegExp(colorFnRe.source, "g");
  const textKeywordRe = new RegExp(keywordRe.source, "gi");

  const scanRegex = (re, getMatchValue) => {
    let match;
    while ((match = re.exec(text)) !== null) {
      const matchValue = getMatchValue(match);
      if (!matchValue) continue;
      const { line, column } = getLineInfoFromIndex(lineStarts, match.index);
      if (suppressedLines.has(line)) {
        continue;
      }
      results.push({
        file: filePath,
        line,
        column,
        match: matchValue,
        lineText: lines[line - 1]?.trim() || "",
        isWarning: false,
        contextBefore: line > 1 ? lines[line - 2]?.trim() || null : null,
        contextAfter: lines[line] ? lines[line]?.trim() || null : null,
      });
    }
  };

  scanRegex(textHexRe, (match) => match[0]);
  scanRegex(textRgbRe, (match) => match[0]);
  scanRegex(textHslRe, (match) => match[0]);
  scanRegex(textColorFnRe, (match) => match[0]);
  scanRegex(textKeywordRe, (match) => {
    const keyword = match[1]?.toLowerCase();
    if (!keyword || ALLOWED_KEYWORDS.has(keyword)) {
      return null;
    }
    return match[1];
  });

  return results;
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

function stripAllComments(text, ext) {
  let result = text;
  if ([".css", ".scss", ".sass", ".less", ".styl"].includes(ext)) {
    result = result.replace(cssCommentRe, "");
  }
  if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
    result = result.replace(cssCommentRe, "");
    result = result.replace(jsCommentRe, "");
  }
  return result;
}

function parseDirective(lineText) {
  const match = lineText.match(directiveRe);
  if (!match) return null;
  const directive = match[1]?.toLowerCase() || "";
  const reason = match[2]?.trim() || "";
  return { directive, reason };
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
    if (/^\s*--(primary|secondary|accent)\s*:/.test(lineText)) {
      return true;
    }
    if (
      /^\s*--color-(success|warning|error|info)\s*:/.test(lineText) ||
      /^\s*--bg-(success|warning|error|info)\s*:/.test(lineText)
    ) {
      return true;
    }
  }
  if (ext === ".svg") {
    if (/\b(pagecolor|bordercolor|inkscape:deskcolor)\s*=/.test(lineText)) {
      return true;
    }
  }
  if (ext === ".js" || ext === ".jsx" || ext === ".ts" || ext === ".tsx") {
    if (/^\s*const\s+DEFAULT_(LIGHT|DARK)_COLORS\s*=/.test(lineText)) {
      return true;
    }
    if (/^\s*const\s+presets\s*=/.test(lineText)) {
      return true;
    }
    if (/\|\|\s*["']#(?:[0-9a-fA-F]{3,6})["']/.test(lineText)) {
      return true;
    }
    if (/^\s+\w+:\s*["']#(?:[0-9a-fA-F]{3,6})["']/.test(lineText)) {
      return true;
    }
    if (lineText.includes("placeholder=") && lineText.includes('"#')) {
      return true;
    }
    if (/\{\s*label:\s*"/.test(lineText) && lineText.includes("colors:")) {
      return true;
    }
  }
  return false;
}

function scanLine(
  results,
  filePath,
  lineNumber,
  lineText,
  allLines,
  suppressedLines,
) {
  if (suppressedLines?.has(lineNumber)) {
    return;
  }
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
  jsColorKeyRe.lastIndex = 0;
  cssPropertyRe.lastIndex = 0;
  cssAtPropertyRe.lastIndex = 0;
  cssAtPropertyInitialValueRe.lastIndex = 0;
  filterColorRe.lastIndex = 0;

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
    while ((match = cssPropertyRe.exec(strippedLine)) !== null) {
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
    while ((match = cssAtPropertyInitialValueRe.exec(strippedLine)) !== null) {
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
    if (cssAtPropertyRe.test(strippedLine)) {
      if (hasHardcodedColorValue(strippedLine)) {
        recordMatch(
          results,
          filePath,
          lineNumber,
          strippedLine.indexOf("@property") + 1,
          "@property",
          lineText,
          false,
          allLines,
        );
      }
    }
    while ((match = filterColorRe.exec(strippedLine)) !== null) {
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
  if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
    while ((match = jsColorKeyRe.exec(strippedLine)) !== null) {
      const rawValue = match[1] ?? "";
      const cleanedValue = rawValue.replace(/^['"`]|['"`]$/g, "");
      if (!hasHardcodedColorValue(cleanedValue)) {
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
  if (tailwindThemeTestRe.test(value)) return true;

  if (colorFnTestRe.test(value)) {
    const colorFnMatchRe = /\b(?:lab|lch|oklab|oklch|color|color-mix)\(\s*([^)]+)\)/gi;
    let match;
    while ((match = colorFnMatchRe.exec(value)) !== null) {
      const inner = match[1] || "";
      const varRe = /var\(--[a-zA-Z0-9-_]+\)/gi;
      const interpolationRe = /\$\{[^}]+\}/gi;
      const hexInInner = hexTestRe.test(inner);
      const rgbInInner = rgbTestRe.test(inner);
      const hslInInner = hslTestRe.test(inner);
      const keywordInInner = keywordTestRe.test(inner);
      const hasVars = varRe.test(inner);
      const hasInterpolation = interpolationRe.test(inner);
      if (!hasVars && !hasInterpolation) {
        return true;
      }
      if ((hexInInner || rgbInInner || hslInInner || keywordInInner) && !hasInterpolation) {
        return true;
      }
    }
    colorFnMatchRe.lastIndex = 0;
    return false;
  }

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
  const suppressedLines = new Set();
  let ignoreFile = false;

  // Stream file line by line to avoid loading entire file into memory
  const fileStream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines.push(line);
  }

  // Process suppression directives before scanning.
  for (let i = 0; i < lines.length; i += 1) {
    const directiveInfo = parseDirective(lines[i]);
    if (!directiveInfo) {
      continue;
    }
    const { directive, reason } = directiveInfo;
    const directiveIndex = lines[i].toLowerCase().indexOf("color-scan");
    const column = directiveIndex >= 0 ? directiveIndex + 1 : 1;

    if (!reason) {
      recordMatch(
        results,
        filePath,
        i + 1,
        column,
        "color-scan: missing reason",
        lines[i],
        false,
        lines,
      );
      continue;
    }

    if (directive === "ignore-file") {
      ignoreFile = true;
      continue;
    }
    if (directive === "ignore-line") {
      suppressedLines.add(i + 1);
      continue;
    }
    if (directive === "ignore-next-line") {
      suppressedLines.add(i + 2);
    }
  }

  if (ignoreFile) {
    return results;
  }

  // Now scan all lines with full context
  for (let i = 0; i < lines.length; i += 1) {
    scanLine(results, filePath, i + 1, lines[i], lines, suppressedLines);
  }

  const fullText = lines.join("\n");
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const baseName = path.basename(filePath).toLowerCase();
  if (
    baseName.startsWith("tailwind.config.") ||
    baseName === "postcss.config.js"
  ) {
    const ext = path.extname(filePath).toLowerCase();
    const strippedFullText = stripAllComments(fullText, ext);
    results.push(
      ...scanTextForColors({
        text: strippedFullText,
        filePath,
        lines,
        lineStarts,
        suppressedLines,
      }),
    );
  }

  const multilinePatterns = [
    { re: classAttrMultilineRe, label: "class" },
    { re: classNameTemplateRe, label: "className" },
    { re: twAttrMultilineRe, label: "tw" },
    { re: twAttrTemplateRe, label: "tw" },
    { re: applyMultilineRe, label: "@apply" },
  ];

  for (const { re } of multilinePatterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(fullText)) !== null) {
      const value = match[1] ?? "";
      const classes = extractTailwindColorClasses(value);
      if (classes.length === 0) {
        continue;
      }
      const { line, column } = getLineInfoFromIndex(lineStarts, match.index);
      if (suppressedLines.has(line)) {
        continue;
      }
      recordMatch(
        results,
        filePath,
        line,
        column,
        classes[0],
        lines[line - 1] || "",
        false,
        lines,
      );
    }
  }

  styleAttrMultilineRe.lastIndex = 0;
  let styleMatch;
  while ((styleMatch = styleAttrMultilineRe.exec(fullText)) !== null) {
    const styleValue = styleMatch[1] ?? "";
    if (!hasHardcodedColorValue(styleValue)) {
      continue;
    }
    const { line, column } = getLineInfoFromIndex(lineStarts, styleMatch.index);
    if (suppressedLines.has(line)) {
      continue;
    }
    recordMatch(
      results,
      filePath,
      line,
      column,
      "style",
      lines[line - 1] || "",
      false,
      lines,
    );
  }

  svgStyleBlockRe.lastIndex = 0;
  let svgStyleMatch;
  while ((svgStyleMatch = svgStyleBlockRe.exec(fullText)) !== null) {
    const styleBlock = svgStyleMatch[1] ?? "";
    if (!hasHardcodedColorValue(styleBlock)) {
      continue;
    }
    const { line, column } = getLineInfoFromIndex(
      lineStarts,
      svgStyleMatch.index,
    );
    if (suppressedLines.has(line)) {
      continue;
    }
    recordMatch(
      results,
      filePath,
      line,
      column,
      "<style>",
      lines[line - 1] || "",
      false,
      lines,
    );
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

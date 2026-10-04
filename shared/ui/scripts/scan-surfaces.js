#!/usr/bin/env node
// Rejects bare `bg-primary` / `bg-secondary` in class strings, the
// all-caps `uppercase` class (headings and labels use sentence case), and
// "naked" `font-mono` — mono used as text emphasis with no other intent.
//
// Bare backgrounds: A background
// set without its text color lets children inherit the outer color — the
// same color as the new background, so the text disappears. Use
// `surface-primary` / `surface-secondary` (index.css), which set both.
//
// Variant forms (hover:bg-secondary, md:bg-primary) and tints (bg-primary/10)
// are allowed: they describe a state or a see-through layer, not a surface.
//
// Naked mono: `font-mono` alone on a span reads as an accidental font
// change, not a deliberate emphasis. A name or literal quoted in copy
// (drive name, path, URL, IP, token, option) must be <InlinePill>. Mono is
// still fine when the class string shows real intent — a size (text-xs,
// text-[10px]), layout (truncate, block, flex, shrink-0), chrome (rounded-*,
// border, bg-*, surface-*, px-*), or data typesetting (tabular-nums) —
// and on headings, titles, code, and inputs. Escape a justified case with:
//   // surface-scan: ignore-line -- reason
//   // surface-scan: ignore-next-line -- reason
//   // surface-scan: ignore-file -- reason
//
// Usage: node scan-surfaces.js <dir> [<dir>...]
import fs from "node:fs";
import path from "node:path";

const BARE = /(?<![\w:/[-])bg-(primary|secondary)(?![\w/\]-])/g;
const CAPS = /(?<![\w:/[-])uppercase(?![\w/\]-])/g;
const LITERAL = /"([^"\n]*)"|`([^`]*)`|'([^'\n]*)'/g;
const DIRECTIVE = /surface-scan:\s*(ignore-next-line|ignore-line|ignore-file)/;

// Tokens that only restyle the text itself. `font-mono` beside nothing but
// these means "the font changed" — the signature this check rejects.
const EMPHASIS_ONLY = new Set([
  "font-mono",
  "font-sans",
  "font-thin",
  "font-extralight",
  "font-light",
  "font-normal",
  "font-medium",
  "font-semibold",
  "font-bold",
  "font-extrabold",
  "font-black",
  "italic",
  "not-italic",
  "antialiased",
  "subpixel-antialiased",
  "capitalize",
  "uppercase",
  "lowercase",
  "normal-case",
  "underline",
  "no-underline",
  "overline",
  "line-through",
  "text-inherit",
  "text-current",
]);
const TEXT_COLOR = /^text-(primary|secondary|accent|error|warning|success|info|muted|foreground|card|popover)(\/\d+)?$/;
const DECORATION = /^(decoration-|underline-offset-)/;

/** True when `font-mono` appears with no size/layout/chrome token alongside. */
function isNakedMono(classText) {
  const tokens = classText.split(/\s+/).filter(Boolean);
  let hasMono = false;
  for (const token of tokens) {
    if (token === "font-mono") {
      hasMono = true;
      continue;
    }
    const bare = token.includes(":") ? token.slice(token.lastIndexOf(":") + 1) : token;
    if (bare === "font-mono") continue; // variant like hover:font-mono — a state, not emphasis
    if (EMPHASIS_ONLY.has(bare) || TEXT_COLOR.test(bare) || DECORATION.test(bare)) continue;
    return false; // a real intent token — size, layout, chrome, or data
  }
  return hasMono;
}

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full;
  }
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("Usage: scan-surfaces.js <dir> [<dir>...]");
  process.exit(2);
}

const problems = [];
const caps = [];
const nakedMono = [];
for (const dir of dirs) {
  for (const file of files(dir)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (lines.some((line) => DIRECTIVE.test(line) && /ignore-file/.test(line))) continue;
    let ignoreNext = false;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      const directive = line.match(DIRECTIVE);
      if (directive?.[1] === "ignore-next-line") {
        ignoreNext = true;
        return;
      }
      if (directive?.[1] === "ignore-line") return;
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      if (ignoreNext) {
        ignoreNext = false;
        return;
      }
      for (const lit of line.matchAll(LITERAL)) {
        const text = lit[1] ?? lit[2] ?? lit[3] ?? "";
        for (const m of text.matchAll(BARE)) {
          problems.push(`${file}:${i + 1}: ${m[0]} → surface-${m[1]}`);
        }
        for (const m of text.matchAll(CAPS)) {
          caps.push(`${file}:${i + 1}: ${m[0]}`);
        }
        // A literal used as a conditional arm (`mono && "font-mono"`,
        // `ghost ? "font-mono" : "font-medium"`) is a component's styling
        // API, not an inline emphasis accident.
        const before = line.slice(Math.max(0, lit.index - 4), lit.index);
        if (!/[&|?:]\s*$/.test(before) && isNakedMono(text)) {
          nakedMono.push(`${file}:${i + 1}: ${text.length > 72 ? `${text.slice(0, 72)}…` : text}`);
        }
      }
    });
  }
}

if (caps.length) {
  console.error(
    `All-caps text (${caps.length}). Remove \`uppercase\`: headings and labels use sentence case.\n\n`
    + caps.map((p) => `  ${p}`).join("\n"),
  );
}
if (problems.length) {
  console.error(
    `Bare surface backgrounds (${problems.length}). Use surface-primary / surface-secondary so the text color comes with the background:\n`
    + problems.map((p) => `  ${p}`).join("\n"),
  );
}
if (nakedMono.length) {
  console.error(
    `Naked font-mono (${nakedMono.length}). Mono alone on text reads as an accidental font change — `
    + `quote names and literals with <InlinePill> instead, or give the element real intent (size, layout, or chrome):\n`
    + nakedMono.map((p) => `  ${p}`).join("\n"),
  );
}
if (problems.length || caps.length || nakedMono.length) process.exit(1);
console.log("No bare surface backgrounds, all-caps text, or naked font-mono.");

#!/usr/bin/env node
// Rejects bare `bg-primary` / `bg-secondary` in class strings, and the
// all-caps `uppercase` class (headings and labels use sentence case).
//
// Bare backgrounds: A background
// set without its text color lets children inherit the outer color — the
// same color as the new background, so the text disappears. Use
// `surface-primary` / `surface-secondary` (index.css), which set both.
//
// Variant forms (hover:bg-secondary, md:bg-primary) and tints (bg-primary/10)
// are allowed: they describe a state or a see-through layer, not a surface.
//
// Usage: node scan-surfaces.js <dir> [<dir>...]
import fs from "node:fs";
import path from "node:path";

const BARE = /(?<![\w:/[-])bg-(primary|secondary)(?![\w/\]-])/g;
const CAPS = /(?<![\w:/[-])uppercase(?![\w/\]-])/g;
const LITERAL = /"([^"\n]*)"|`([^`]*)`|'([^'\n]*)'/g;

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
for (const dir of dirs) {
  for (const file of files(dir)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      for (const lit of line.matchAll(LITERAL)) {
        const text = lit[1] ?? lit[2] ?? lit[3] ?? "";
        for (const m of text.matchAll(BARE)) {
          problems.push(`${file}:${i + 1}: ${m[0]} → surface-${m[1]}`);
        }
        for (const m of text.matchAll(CAPS)) {
          caps.push(`${file}:${i + 1}: ${m[0]}`);
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
if (problems.length || caps.length) process.exit(1);
console.log("No bare surface backgrounds or all-caps text.");

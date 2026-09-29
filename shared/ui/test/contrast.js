/**
 * Contrast check for rendered tests. jsdom has no stylesheet, so this reads
 * the theme's class names instead of computed colors: for every piece of
 * visible text, icon, and form field it finds the surface behind it (nearest
 * `surface-*` / `bg-primary` / `bg-secondary`) and the text color it gets
 * (nearest `surface-*` / `text-primary` / `text-secondary`, inherited). Text
 * whose color token equals its surface token is invisible — the bug this
 * catches, however far apart the two classes are in the tree.
 *
 * An element painted by a sibling (a sliding indicator) declares the surface
 * behind it with `data-contrast-surface="primary|secondary"` (not
 * `data-surface`: Button uses that for the backdrop it's *meant* for). Opt out one subtree with
 * `data-contrast-skip` (say why next to it).
 */

import { afterEach } from "vitest";

// Unprefixed tokens only: hover:, md:, dark: variants describe other states.
const SURFACE_RE = /^(?:surface|bg)-(primary|secondary)$/;
const TEXT_RE = /^text-(primary|secondary)$/;
// bg-* utilities that don't paint a color, or paint a see-through one.
const NON_COLOR_BG_RE = /^bg-(transparent|none|clip-.*|origin-.*|fixed|local|scroll|repeat.*|no-repeat|cover|contain|auto|center|top|bottom|left|right|blend-.*|linear-.*|radial-.*|conic-.*|gradient-.*|\[url\(.*)$|\//;
// Text colors other than the two surface tokens — not this check's business.
const OTHER_TEXT_RE = /^text-(accent|error|success|warning|info|current|inherit|transparent|white|black|foreground|background)$/;

const OPPOSITE = { primary: "secondary", secondary: "primary" };

/** @param {Element} el */
function classesOf(el) {
  const raw = el.getAttribute("class");
  return raw ? raw.split(/\s+/).filter(Boolean) : [];
}

/**
 * The surface token behind `el`: "primary", "secondary", or null when an
 * opaque non-theme background is in the way. Tints (`bg-error/20`) and
 * `bg-transparent` show what's behind them, so the walk continues.
 *
 * @param {Element} el
 * @returns {{ token: string|null, at: Element|null }}
 */
function surfaceOf(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    // Declared surface for backgrounds painted by another element (a sliding
    // indicator behind a selected segment).
    const declared = node.getAttribute("data-contrast-surface");
    if (declared === "primary" || declared === "secondary") return { token: declared, at: node };
    for (const c of classesOf(node)) {
      const m = SURFACE_RE.exec(c);
      if (m) return { token: m[1], at: node };
      // Any other opaque color (bg-accent, bg-[color-mix(...)]) is a
      // surface this check can't name — stop without judging.
      if (c.startsWith("bg-") && !NON_COLOR_BG_RE.test(c)) return { token: null, at: node };
    }
  }
  // No surface rendered at all: a component tested outside its real
  // container. Unknown, not the page — pages render their own surface.
  return { token: null, at: null };
}

/**
 * The text color token `el` renders with, following inheritance.
 *
 * @param {Element} el
 * @returns {{ token: string|null, at: Element|null }}
 */
function textOf(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const classes = classesOf(node);
    // A single text utility beats the surface's color on the same element.
    for (const c of classes) {
      const m = TEXT_RE.exec(c);
      if (m) return { token: m[1], at: node };
      if (OTHER_TEXT_RE.test(c)) return { token: null, at: node };
    }
    for (const c of classes) {
      const m = /^surface-(primary|secondary)$/.exec(c);
      if (m) return { token: OPPOSITE[m[1]], at: node };
    }
  }
  return { token: "secondary", at: null };
}

/** @param {Element} el */
function isHidden(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.hasAttribute("data-contrast-skip")) return true;
    const classes = classesOf(node);
    if (classes.includes("sr-only") || classes.includes("hidden") || classes.includes("invisible") || classes.includes("opacity-0")) {
      return true;
    }
    const style = /** @type {HTMLElement} */ (node).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return true;
  }
  return false;
}

/** Short, recognizable label for an element in failure output. */
function describe(el) {
  if (!el) return "(page)";
  const tag = el.tagName.toLowerCase();
  const cls = classesOf(el).join(" ").slice(0, 240);
  const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return `<${tag}${cls ? ` class="${cls}"` : ""}>${text ? ` "${text}"` : ""}`;
}

/** Elements that paint text or glyphs: direct text, icons, form fields. */
function paintedElements(root) {
  const out = new Set();
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!n.nodeValue?.trim() || !parent) continue;
    const tag = parent.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "title" || tag === "option") continue;
    // Text inside an SVG is covered by the SVG itself.
    if (parent.closest("svg")) continue;
    out.add(parent);
  }
  for (const el of root.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), textarea, select")) {
    out.add(el);
  }
  for (const svg of root.querySelectorAll("svg")) {
    if (!svg.parentElement?.closest("svg")) out.add(svg);
  }
  return out;
}

/**
 * Every painted element whose text color matches the surface behind it.
 *
 * @param {Element} [root]
 * @returns {string[]}
 */
export function findContrastProblems(root = document.body) {
  const problems = [];
  for (const el of paintedElements(root)) {
    if (isHidden(el)) continue;
    const surface = surfaceOf(el);
    const text = textOf(el);
    if (!surface.token || !text.token || surface.token !== text.token) continue;
    problems.push(
      `${describe(el)}\n    text-${text.token} from ${describe(text.at)}\n    on ${surface.token} surface from ${describe(surface.at)}`,
    );
  }
  return problems;
}

/**
 * Fail any test that leaves invisible text on screen. Call once from a
 * vitest setup file, after @testing-library/react is imported: vitest runs
 * afterEach hooks in reverse order, so this sees the DOM before cleanup.
 */
export function installContrastCheck() {
  afterEach(() => {
    // Node-environment test files have no DOM to check.
    if (typeof document === "undefined") return;
    const problems = findContrastProblems();
    if (problems.length === 0) return;
    throw new Error(
      `Invisible text: ${problems.length} element(s) use the same color token as the surface behind them.\n`
      + "Give the element that changes the background its matching text color (use surface-primary / surface-secondary).\n\n"
      + problems.join("\n\n"),
    );
  });
}

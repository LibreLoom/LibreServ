// Settings search without a hand-kept list. Every setting is already drawn with
// SettingsCard / SettingsRow, which mark themselves with data-settings-* attributes.
// We render each category to static markup, read those marks back into an index,
// and later find the same marks in the live page to scroll to a hit. Add a card or
// row the normal way and it is searchable; nothing else to update.

/**
 * @typedef {object} SettingsHit
 * @property {"category" | "card" | "row"} kind
 * @property {string} categoryId
 * @property {string} categoryLabel
 * @property {string} title Card title, row label, or category name.
 * @property {string} cardTitle The card a row sits in ("" for cards and categories).
 * @property {string} text Everything else said there, for matching and the preview line.
 */

/** Lowercase, no accents, single spaces. @param {string} value */
export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Readable text of an element: neighbouring elements get a space between them. @param {Element | null | undefined} el */
function textOf(el) {
  if (!el) return "";
  const copy = /** @type {Element} */ (el.cloneNode(true));
  copy.querySelectorAll("*").forEach((node) => node.after(" "));
  return (copy.textContent || "").replace(/\s+/g, " ").trim();
}

const CARD = '[data-settings-item="card"]';
const ROW = '[data-settings-item="row"]';

/**
 * Cards and rows inside one rendered category.
 * @param {ParentNode} root
 * @returns {{ kind: "card" | "row", title: string, cardTitle: string, text: string }[]}
 */
export function extractSettingsItems(root) {
  /** @type {{ kind: "card" | "row", title: string, cardTitle: string, text: string }[]} */
  const items = [];
  for (const el of root.querySelectorAll(`${CARD}, ${ROW}`)) {
    if (el.matches(CARD)) {
      const title = textOf(el.querySelector("h2"));
      const body = /** @type {Element} */ (el.cloneNode(true));
      body.querySelectorAll(`${ROW}, h2`).forEach((n) => n.remove());
      if (title) items.push({ kind: "card", title, cardTitle: "", text: textOf(body) });
    } else {
      const title = textOf(el.querySelector("[data-settings-label]"));
      const cardTitle = textOf(el.closest(CARD)?.querySelector("h2"));
      const description = textOf(el.querySelector("[data-settings-description]"));
      if (title) items.push({ kind: "row", title, cardTitle, text: description });
    }
  }
  return items;
}

/**
 * Render every category and collect what it says. A category that cannot render
 * on its own (needs live data first) still gets its own entry.
 *
 * @param {{ id: string, label: string, Component: import("react").ComponentType }[]} categories
 * @param {(node: import("react").ReactNode) => import("react").ReactNode} wrap Adds the providers the categories need.
 * @param {{ onError?: (id: string, error: unknown) => void }} [options]
 * @returns {Promise<SettingsHit[]>}
 */
export async function buildSettingsIndex(categories, wrap, { onError } = {}) {
  const [{ createElement }, { renderToStaticMarkup }] = await Promise.all([
    import("react"),
    import("react-dom/server"),
  ]);
  /** @type {SettingsHit[]} */
  const hits = [];
  for (const { id, label, Component } of categories) {
    hits.push({ kind: "category", categoryId: id, categoryLabel: label, title: label, cardTitle: "", text: "" });
    try {
      const html = renderToStaticMarkup(/** @type {any} */ (wrap(createElement(Component))));
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const item of extractSettingsItems(doc.body)) {
        hits.push({ ...item, categoryId: id, categoryLabel: label });
      }
    } catch (error) {
      onError?.(id, error);
    }
  }
  return hits;
}

// The index is fixed once built, but searching runs on every keystroke:
// normalize each hit's text once, not once per key press.
const normalizedCache = new WeakMap();
/** @param {SettingsHit} hit */
function normalizedHit(hit) {
  let n = normalizedCache.get(hit);
  if (!n) {
    const title = normalize(hit.title);
    n = {
      title,
      titleWords: title.split(" "),
      card: normalize(hit.cardTitle),
      category: normalize(hit.categoryLabel),
      text: normalize(hit.text),
    };
    normalizedCache.set(hit, n);
  }
  return n;
}

/**
 * Hits for what the person typed, best first. Every word has to appear somewhere
 * in a hit; words in the name count for more than words in the small print.
 *
 * @param {SettingsHit[]} index
 * @param {string} query
 * @param {number} [limit]
 */
export function searchSettings(index, query, limit = 30) {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  /** @type {{ hit: SettingsHit, score: number, order: number }[]} */
  const scored = [];
  index.forEach((hit, order) => {
    const { title, titleWords, card, category, text } = normalizedHit(hit);
    let score = 0;
    for (const word of words) {
      let best = 0;
      if (titleWords.some((w) => w.startsWith(word))) best = 6;
      else if (title.includes(word)) best = 4;
      else if (card.includes(word)) best = 3;
      else if (category.includes(word)) best = 2;
      else if (text.includes(word)) best = 1;
      if (best === 0) return;
      score += best;
    }
    scored.push({ hit, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.hit);
}

/**
 * The element for a hit in the live page, or null while it has not rendered yet.
 * @param {ParentNode} root
 * @param {SettingsHit} hit
 */
export function findSettingsTarget(root, hit) {
  if (hit.kind === "category") return null;
  const title = normalize(hit.title);
  const cardTitle = normalize(hit.cardTitle);
  for (const el of root.querySelectorAll(hit.kind === "card" ? CARD : ROW)) {
    if (hit.kind === "card") {
      if (normalize(textOf(el.querySelector("h2"))) === title) return el;
    } else if (
      normalize(textOf(el.querySelector("[data-settings-label]"))) === title
      && normalize(textOf(el.closest(CARD)?.querySelector("h2"))) === cardTitle
    ) {
      return el;
    }
  }
  return null;
}

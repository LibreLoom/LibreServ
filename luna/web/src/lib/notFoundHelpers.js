/**
 * Not-Found Page Helpers
 *
 * Pure helpers for the 404 page: URL normalization, fuzzy "did you mean?"
 * matching via Levenshtein distance, and stable quip selection. Extracted
 * from NotFoundPage.jsx (Forgejo #73) so the page component holds only
 * rendering, not string-matching logic.
 */

// djb2-ish hash: small, fast, deterministic.
export function hashString(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

// Collapse empty and trailing slash variations to a consistent form.
export function normalizePathname(pathname) {
  const value = String(pathname ?? "").trim();
  if (!value) return "/";
  const withoutTrailingSlashes = value.replace(/\/+$/, "");
  return withoutTrailingSlashes || "/";
}

export function getPrimarySegment(pathname) {
  const parts = String(pathname ?? "")
    .split("/")
    .filter(Boolean);
  return parts[0] ?? "";
}

export function levenshteinDistance(firstInput, secondInput) {
  const first = String(firstInput);
  const second = String(secondInput);

  if (first === second) return 0;
  if (!first) return second.length;
  if (!second) return first.length;

  // Use the shorter string for columns to minimize memory.
  let a = first;
  let b = second;
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const aLength = a.length;
  const bLength = b.length;

  let previous = new Array(aLength + 1);
  let current = new Array(aLength + 1);

  for (let i = 0; i <= aLength; i += 1) {
    previous[i] = i;
  }

  for (let j = 1; j <= bLength; j += 1) {
    current[0] = j;
    const bCode = b.charCodeAt(j - 1);
    for (let i = 1; i <= aLength; i += 1) {
      const cost = a.charCodeAt(i - 1) === bCode ? 0 : 1;
      current[i] = Math.min(
        current[i - 1] + 1,
        previous[i] + 1,
        previous[i - 1] + cost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[aLength];
}

/**
 * Score known routes for "close enough" suggestions against the attempted
 * path. Returns a sorted array of scored candidates (best match first).
 * Pure: identical inputs always yield identical output.
 *
 * @param {string} normalizedPathname - Already-normalized pathname
 *   (see {@link normalizePathname}).
 * @param {Array<{ to: string, label: string, match?: string }>} knownPages -
 *   Routes to match. `match` overrides the path that is scored (aliases).
 * @returns {Array<object>} Scored candidates with match metadata, sorted
 *   best-first.
 */
export function scoreKnownPages(normalizedPathname, knownPages) {
  const pathnameForMatch = normalizedPathname.toLowerCase();
  const primarySegment = getPrimarySegment(pathnameForMatch);

  const minCharsForGuess = 2;
  const typedIsShort = primarySegment.length < minCharsForGuess;

  const scored = knownPages.map((page) => {
    // `match` lets an alias ("/pictures") score on behalf of its real route.
    const candidatePath = (page.match ?? page.to).toLowerCase();
    const candidateSegment = getPrimarySegment(candidatePath);

    const isPathPrefix =
      pathnameForMatch === candidatePath ||
      pathnameForMatch.startsWith(`${candidatePath}/`);

    const isTypedPrefixOfCandidate =
      !typedIsShort && candidateSegment.startsWith(primarySegment);

    const isCandidatePrefixOfTyped =
      primarySegment.startsWith(candidateSegment) &&
      candidateSegment.length >= minCharsForGuess;

    const lettersOff = typedIsShort
      ? Number.POSITIVE_INFINITY
      : levenshteinDistance(primarySegment, candidateSegment);

    const score =
      isPathPrefix || isTypedPrefixOfCandidate || isCandidatePrefixOfTyped
        ? 0
        : lettersOff;

    const maxLen = Math.max(primarySegment.length, candidateSegment.length);
    const maxTypos = maxLen <= 4 ? 2 : maxLen <= 8 ? 3 : 4;

    const isClose =
      isPathPrefix ||
      isTypedPrefixOfCandidate ||
      isCandidatePrefixOfTyped ||
      (!typedIsShort &&
        primarySegment.length >= 3 &&
        Number.isFinite(lettersOff) &&
        lettersOff <= maxTypos &&
        lettersOff / Math.max(1, maxLen) <= 0.5);

    return {
      ...page,
      candidatePath,
      candidateSegment,
      isPathPrefix,
      isTypedPrefixOfCandidate,
      isCandidatePrefixOfTyped,
      lettersOff,
      score,
      isClose,
    };
  });

  // Deterministic order avoids "random" suggestions for tied scores.
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;

    const aLetters = Number.isFinite(a.lettersOff) ? a.lettersOff : Infinity;
    const bLetters = Number.isFinite(b.lettersOff) ? b.lettersOff : Infinity;
    if (aLetters !== bLetters) return aLetters - bLetters;

    if (a.candidatePath.length !== b.candidatePath.length) {
      return a.candidatePath.length - b.candidatePath.length;
    }

    return a.label.localeCompare(b.label);
  });

  return scored;
}

/**
 * Pick a stable quip for a given attempted URL (same URL -> same quip).
 *
 * @param {string} attemptedPath - The full attempted path (path + search + hash).
 * @param {string[]} quips - Available quips.
 * @returns {string} A quip, or "" if none are available.
 */
export function pickStableQuip(attemptedPath, quips) {
  if (!Array.isArray(quips) || quips.length === 0) return "";
  return quips[hashString(attemptedPath) % quips.length];
}

/**
 * Keep only the best-scoring close match per destination, so a route and
 * its aliases never suggest the same page twice.
 *
 * @param {Array<object>} scored - Output of {@link scoreKnownPages}.
 * @param {number} [limit=2] - Maximum suggestions.
 * @returns {Array<object>} Distinct close matches tied for the best score.
 */
export function bestDistinctMatches(scored, limit = 2) {
  const close = scored.filter((match) => match.isClose);
  if (close.length === 0) return [];
  const bestScore = close[0].score;
  const seen = new Set();
  const out = [];
  for (const match of close) {
    if (match.score !== bestScore || seen.has(match.to)) continue;
    seen.add(match.to);
    out.push(match);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Turn the last segment of a dead URL into something worth searching for:
 * an old link to `/Documents/Tax%202024.pdf` becomes "Tax 2024.pdf", and
 * a slug like `summer-trip` becomes "summer trip".
 *
 * @param {string} normalizedPathname - See {@link normalizePathname}.
 * @returns {string} Search term, or "" when nothing useful is left.
 */
export function guessSearchTerm(normalizedPathname) {
  const last = String(normalizedPathname ?? "")
    .split("/")
    .filter(Boolean)
    .pop();
  if (!last) return "";

  let term = last;
  try {
    term = decodeURIComponent(last);
  } catch {
    // Malformed escapes: search the raw text.
  }
  term = term.trim();
  // File names keep their punctuation; slugs read better as words.
  if (!/\.[a-z0-9]{1,5}$/i.test(term)) {
    term = term.replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim();
  }
  return term.length >= 2 ? term.slice(0, 80) : "";
}

/* ======================================================================
   Moon phase — the 404's "0" is tonight's real moon.
   ====================================================================== */

const SYNODIC_MONTH_DAYS = 29.530588853;
// A well-documented new moon: 2000-01-06 18:14 UTC.
const REFERENCE_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const DAY_MS = 86_400_000;

/**
 * Moon phase as a fraction of the lunar cycle: 0 = new, 0.25 = first
 * quarter, 0.5 = full, 0.75 = last quarter. Accurate to within a few hours,
 * which is plenty for a drawing.
 *
 * @param {Date} [date]
 * @returns {number} Phase in [0, 1).
 */
export function moonPhase(date = new Date()) {
  const days = (date.getTime() - REFERENCE_NEW_MOON_MS) / DAY_MS;
  const phase = (days / SYNODIC_MONTH_DAYS) % 1;
  return phase < 0 ? phase + 1 : phase;
}

/**
 * Fraction of the visible disc that is lit, 0..1.
 *
 * @param {number} phase - See {@link moonPhase}.
 */
export function moonIllumination(phase) {
  return (1 - Math.cos(2 * Math.PI * phase)) / 2;
}

/**
 * Plain name for a phase ("Waxing crescent", "Full moon", …).
 *
 * @param {number} phase - See {@link moonPhase}.
 */
export function moonPhaseName(phase) {
  const names = [
    "New moon",
    "Waxing crescent",
    "First quarter",
    "Waxing gibbous",
    "Full moon",
    "Waning gibbous",
    "Last quarter",
    "Waning crescent",
  ];
  const p = ((phase % 1) + 1) % 1;
  return names[Math.round(p * 8) % 8];
}

/**
 * SVG path for the lit part of the moon, as seen from the northern
 * hemisphere (waxing = lit on the right). The limb is a half circle; the
 * terminator is a half ellipse whose width follows cos(phase).
 *
 * @param {number} phase - See {@link moonPhase}.
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @returns {string} Path data ("" at new moon).
 */
export function moonLitPath(phase, cx, cy, r) {
  const p = ((phase % 1) + 1) % 1;
  if (moonIllumination(p) < 0.005) return "";

  const terminatorX = r * Math.cos(2 * Math.PI * p);
  const rx = Math.abs(terminatorX);
  const waxing = p < 0.5;
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;

  // Limb: top → bottom around the lit side (clockwise = right).
  const limbSweep = waxing ? 1 : 0;
  // Terminator: bottom → top. A crescent bulges toward the lit limb,
  // a gibbous moon away from it.
  const crescent = terminatorX > 0;
  const termSweep = waxing ? (crescent ? 0 : 1) : crescent ? 1 : 0;

  return (
    `M ${top} A ${r} ${r} 0 0 ${limbSweep} ${bottom} ` +
    `A ${rx} ${r} 0 0 ${termSweep} ${top} Z`
  );
}

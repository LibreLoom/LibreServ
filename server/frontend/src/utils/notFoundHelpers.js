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
 * @param {Array<{ to: string, label: string }>} knownPages - Routes to match.
 * @returns {Array<object>} Scored candidates with match metadata, sorted
 *   best-first.
 */
export function scoreKnownPages(normalizedPathname, knownPages) {
  const pathnameForMatch = normalizedPathname.toLowerCase();
  const primarySegment = getPrimarySegment(pathnameForMatch);

  const minCharsForGuess = 2;
  const typedIsShort = primarySegment.length < minCharsForGuess;

  const scored = knownPages.map((page) => {
    const candidatePath = page.to.toLowerCase();
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
import { useEffect, useMemo, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronDown, Ghost, Home, LifeBuoy } from "lucide-react";

import { notfound as quips } from "../assets/greetings";

import Card from "../components/common/cards/Card";
import HeaderCard from "../components/common/cards/HeaderCard";

/* ======================================================================
   Helpers
   ====================================================================== */

function hashString(value) {
  // djb2-ish hash: small, fast, deterministic.
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

function normalizePathname(pathname) {
  // Collapse empty and trailing slash variations to a consistent form.
  const value = String(pathname ?? "").trim();
  if (!value) return "/";
  const withoutTrailingSlashes = value.replace(/\/+$/, "");
  return withoutTrailingSlashes || "/";
}

function getPrimarySegment(pathname) {
  const parts = String(pathname ?? "")
    .split("/")
    .filter(Boolean);
  return parts[0] ?? "";
}

function levenshteinDistance(firstInput, secondInput) {
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

/* ======================================================================
   Known pages + safe quips
   ====================================================================== */

const knownPages = [
  { to: "/apps", label: "Apps" },
  { to: "/users", label: "Users" },
  { to: "/settings", label: "Settings" },
  { to: "/help", label: "Help" },
];

const fallbackQuips = [
  "This page has left the building. The snacks followed.",
  "404. The seagull stole must have stolen the page.",
  "The link went on an adventure and forgot to come back. Maybe it was looking for snacks?",
];

// Resolve once; avoids modulo-by-zero and avoids hook dependency noise.
const SAFE_QUIPS =
  Array.isArray(quips) && quips.length > 0 ? quips : fallbackQuips;

/* ======================================================================
   Component
   ====================================================================== */

export default function NotFoundPage({ includeMain = true }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [isInvestigationOpen, setIsInvestigationOpen] = useState(false);

  // Region labeling should not rely on HeaderCard IDs (HeaderCard duplicates IDs across breakpoints).
  const regionTitleId = useId();
  const detailsId = useId();
  const investigationId = useId();

  const pathname = normalizePathname(location.pathname);
  const search = String(location.search ?? "");
  const hash = String(location.hash ?? "");
  const attemptedPath = `${pathname}${search}${hash}`;

  const pathnameForMatch = pathname.toLowerCase();
  const primarySegment = getPrimarySegment(pathnameForMatch);

  const quip = useMemo(() => {
    // Stable quip for a given attempted URL.
    const index = hashString(attemptedPath) % SAFE_QUIPS.length;
    return SAFE_QUIPS[index];
  }, [attemptedPath]);

  const matches = useMemo(() => {
    // Score known routes for "close enough" suggestions.
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

    // Deterministic order avoids “random” suggestions for tied scores.
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
  }, [pathnameForMatch, primarySegment]);

  const suggestedPages = useMemo(() => {
    // Keep suggestions short to avoid overwhelming the user.
    const closeMatches = matches.filter((match) => match.isClose);
    if (closeMatches.length === 0) return [];

    const bestScore = closeMatches[0].score;
    const bestMatches = closeMatches.filter(
      (match) => match.score === bestScore,
    );

    return bestMatches.slice(0, 2);
  }, [matches]);

  const bestMatch = matches[0] ?? null;
  const bestMatchIsClose = bestMatch?.isClose ?? false;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "404 — Page Not Found · LibreServ";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  // Focus the main region when landing on 404 (good for a11y + keyboard users).
  // Remove the “mystery grey line” by disabling default focus outline on the wrapper (see Wrapper classes below).
  useEffect(() => {
    const main = document.getElementById("main-content");
    if (main && typeof main.focus === "function") main.focus();
  }, [attemptedPath]);

  function handleGoBack() {
    // If there's history, go back. Otherwise, go home.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/", { replace: true });
    }
  }

  const Wrapper = includeMain ? "main" : "section";

  // Accordion a11y safety: when closed, keep it out of pointer interactions.
  // (No interactive elements inside today, but this prevents future foot-guns.)
  const panelA11yProps = isInvestigationOpen
    ? {}
    : {
        "aria-hidden": true,
        inert: "",
      };

  // Shared button/link base class:
  // IMPORTANT: `focus:outline-none` removes the browser default :focus outline (the “weird grey line”).
  // We still keep `focus-visible:*` for keyboard users.
  const solidPill =
    "inline-flex items-center gap-2 rounded-pill bg-primary text-secondary px-4 py-2 text-sm font-medium " +
    "motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid " +
    "focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

  const ghostPill =
    "inline-flex items-center gap-2 rounded-pill bg-transparent text-primary px-4 py-2 text-sm font-medium outline-2 outline-accent " +
    "motion-safe:transition-all hover:bg-primary hover:text-secondary hover:outline-0 " +
    "focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

  return (
    <Wrapper
      className="bg-primary text-secondary px-8 pt-10 pb-32 focus:outline-none!"
      aria-labelledby={regionTitleId}
      aria-describedby={detailsId}
      id="main-content"
      tabIndex={-1}
    >
      {/* Reliable region label (does not depend on HeaderCard internals). */}
      <span id={regionTitleId} className="sr-only">
        Page Not Found
      </span>

      <div className="mx-auto w-full max-w-5xl">
        <div className="grid gap-8 items-start lg:grid-cols-2">
          <HeaderCard
            title="Page Not Found"
            align="center"
            dynamicRounding={false}
            className="p-8 outline-2 outline-accent text-center motion-reduce:animate-none"
            leftContent={
              <div className="h-16 w-16 rounded-pill bg-primary text-secondary flex items-center justify-center shrink-0">
                <Ghost size={30} aria-hidden="true" />
              </div>
            }
            bottomContentClassName="text-left"
            bottomContent={
              <div className="flex flex-col gap-6">
                <div>
                  <p className="font-mono text-sm font-normal uppercase tracking-widest text-accent">
                    Error 404
                  </p>
                  <p id={detailsId} className="mt-3 text-accent max-w-prose">
                    {quip}
                  </p>
                </div>

                <div>
                  <p className="text-sm text-accent">You tried to visit</p>
                  <code className="mt-2 block w-full overflow-x-auto rounded-large-element bg-primary/10 p-4 font-mono text-sm text-primary">
                    {attemptedPath || "/"}
                  </code>
                </div>

                {suggestedPages.length > 0 && (
                  <div className="rounded-large-element bg-primary/10 p-6">
                    <h2 className="font-mono font-normal">Did you mean…</h2>
                    <p className="mt-2 text-sm text-accent max-w-prose">
                      We found a close match.
                    </p>
                    <ul className="mt-4 flex flex-wrap gap-3">
                      {suggestedPages.map((page) => (
                        <li key={page.to}>
                          <Link to={page.to} className={solidPill}>
                            {page.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            }
          />

          <Card className="p-8 outline-2 outline-accent text-left motion-reduce:animate-none">
            <h2 className="text-xl font-mono font-normal block text-center">
              Quick Ways Out
            </h2>
            <p className="mt-2 text-accent max-w-prose block text-center">
              Try a safe page. We won't judge! Well, the owl might...
            </p>

            <div className="mt-6 flex flex-wrap gap-3 justify-center">
              <button
                type="button"
                onClick={handleGoBack}
                className={solidPill}
              >
                <ArrowLeft size={18} aria-hidden="true" />
                Go back
              </button>

              <Link to="/" className={solidPill}>
                <Home size={18} aria-hidden="true" />
                Home
              </Link>

              <Link to="/help" className={ghostPill}>
                <LifeBuoy size={18} aria-hidden="true" />
                Help
              </Link>
            </div>

            <div className="mt-8 rounded-large-element bg-primary/10 p-6">
              <h3 className="font-mono font-normal">
                If This Surprised You (Valid Reaction)
              </h3>
              <ul className="mt-3 list-disc pl-5 text-accent space-y-2">
                <li>Check for a small typo (they’re sneaky).</li>
                <li>Use the navigation to find what you need.</li>
                <li>
                  If you tapped a link, it might be old (or mildly cursed).
                </li>
              </ul>
            </div>

            <div className="mt-6 rounded-large-element bg-primary/10 p-2">
              <button
                type="button"
                onClick={() => setIsInvestigationOpen((open) => !open)}
                aria-expanded={isInvestigationOpen}
                aria-controls={investigationId}
                className={
                  "w-full flex items-center justify-between gap-3 rounded-large-element px-4 py-3 font-bold text-left " +
                  "focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
                }
              >
                <span>Highly Scientific Investigation (Optional)</span>
                <ChevronDown
                  size={20}
                  aria-hidden="true"
                  className={`shrink-0 motion-safe:transition-transform duration-200 ${
                    isInvestigationOpen ? "rotate-180" : "rotate-0"
                  }`}
                />
              </button>

              <div
                id={investigationId}
                {...panelA11yProps}
                className={`overflow-hidden px-4 ${
                  isInvestigationOpen
                    ? "max-h-128 pb-4 opacity-100"
                    : "max-h-0 pb-0 opacity-0 pointer-events-none select-none"
                } motion-safe:transition-all motion-safe:duration-300 ease-out`}
              >
                <div className="pt-2 text-accent">
                  {bestMatch ? (
                    <p className="text-sm">
                      Close-Enough-O-Meter:{" "}
                      <span className="font-bold text-primary">
                        {bestMatchIsClose ? "pretty close" : "not close"}
                      </span>
                      .{" "}
                      {bestMatchIsClose && bestMatch.isPathPrefix ? (
                        <>
                          It starts like{" "}
                          <span className="font-bold text-primary">
                            {bestMatch.label}
                          </span>{" "}
                          and then takes a detour.
                        </>
                      ) : bestMatchIsClose && bestMatch.score === 0 ? (
                        <>
                          It looks like you were aiming for{" "}
                          <span className="font-bold text-primary">
                            {bestMatch.label}
                          </span>
                          .
                        </>
                      ) : bestMatchIsClose &&
                        Number.isFinite(bestMatch.lettersOff) ? (
                        <>
                          Closest match:{" "}
                          <span className="font-bold text-primary">
                            {bestMatch.label}
                          </span>{" "}
                          (about{" "}
                          <span className="font-bold text-primary">
                            {bestMatch.lettersOff}
                          </span>{" "}
                          {bestMatch.lettersOff === 1 ? "letter" : "letters"}{" "}
                          off).
                        </>
                      ) : (
                        <>
                          Closest guess was{" "}
                          <span className="font-bold text-primary">
                            {bestMatch.label}
                          </span>
                          , but we’re not confident.
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="text-sm">
                      We tried our best. The page is still missing.
                    </p>
                  )}

                  <ul className="mt-4 list-disc pl-5 space-y-2 text-sm">
                    <li>Result: this page is not in the building.</li>
                    <li>
                      Next step:{" "}
                      {suggestedPages.length > 0
                        ? "try the suggestion we found."
                        : "head home and try again."}
                    </li>
                    <li>Bonus theory: it wandered off to find the snacks.</li>
                  </ul>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Wrapper>
  );
}

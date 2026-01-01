import { useEffect, useMemo, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronDown, Ghost, Home, LifeBuoy } from "lucide-react";

import Card from "../components/common/cards/Card";

const quips = [
  "The pigeon checked the map. Then checked it again. This page is not on it.",
  "The page is missing. The pigeon filed the paperwork immediately.",
  "We asked the pigeon. The pigeon asked the mouse intern. The intern shrugged.",
  "The pigeon opened this door carefully. There was nothing behind it.",
  "According to the pigeon, this page was here earlier. Allegedly.",
  "The pigeon searched high and low. Mostly low. Still no page.",
  "The page is missing. The raccoon accountant says the numbers don’t add up.",
  "The pigeon suspects crumbs are involved. The seagull refuses to comment.",
  "This page took a wrong turn. The pigeon made a note.",
  "The pigeon left a sign here that says ‘Not this way’. Very official.",

  "The mouse intern swears this page existed. The pigeon remains unconvinced.",
  "The pigeon checked the snack drawer first. Force of habit.",
  "This page is absent. The turtle from HR is remaining calm about it.",
  "The pigeon believes this is a navigation issue, not a personal failure.",
  "The owl auditor looked once and said nothing. That was worse.",
  "The pigeon marked this page as ‘missing but polite’.",
  "We searched everywhere. The seagull searched *enthusiastically*. No page.",
  "The pigeon adjusted its tiny tie and apologized professionally.",
  "This page has gone rogue. The pigeon is drafting a policy.",
  "The raccoon accountant insists the page was never budgeted for.",

  "The pigeon retraced every step. The steps did not lead here.",
  "This page is currently unavailable due to being completely gone.",
  "The pigeon believes this page is ‘on a break’.",
  "We asked nicely. The pigeon asked firmly. The page still didn’t return.",
  "The mouse intern labeled this incident ‘educational’.",
  "The pigeon suspects the seagull knows something.",
  "This page is missing. Snack morale has been affected slightly.",
  "The pigeon checked behind the couch. Still nothing.",
  "The turtle from HR says this is ‘one of those things’.",
  "The pigeon filed this under ‘unexpected but manageable’.",

  "The page is not here. The pigeon would like you to know it tried.",
  "This link went on an adventure. The pigeon stayed behind.",
  "The pigeon believes the page took a scenic route and forgot to come back.",
  "We looked everywhere reasonable. The pigeon looked everywhere unreasonable.",
  "The pigeon insists this is not anyone’s fault.",
  "The owl auditor wrote ‘404’ and stared meaningfully.",
  "The pigeon left breadcrumbs. The page did not follow them.",
  "This page is missing. The pigeon recommends returning to safety.",
  "The raccoon accountant says losses are within acceptable limits.",
  "The pigeon says this happens sometimes and it’s okay.",

  "The page is gone. The pigeon is already reorganizing around it.",
  "This is an empty room. The pigeon checked twice.",
  "The pigeon is confident the correct page is nearby.",
  "We found the problem. The page isn’t here.",
  "The mouse intern learned a valuable lesson just now.",
  "The pigeon marked this location ‘non-page’.",
  "The seagull flew by laughing. The pigeon took notes.",
  "This page failed to report for duty.",
  "The pigeon assures you everything else is still in order.",
  "If this page existed, the pigeon would have organized it already.",
];

function hashString(value) {
  // djb2-ish hash: small, fast, deterministic.
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
}

function normalizePathname(pathname) {
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

const knownPages = [
  { to: "/apps", label: "Apps" },
  { to: "/users", label: "Users" },
  { to: "/settings", label: "Settings" },
  { to: "/help", label: "Help" },
];

export default function NotFoundPage({ includeMain = true }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [isInvestigationOpen, setIsInvestigationOpen] = useState(false);

  const titleId = useId();
  const detailsId = useId();
  const investigationId = useId();

  const pathname = normalizePathname(location.pathname);
  const attemptedPath = `${pathname}${location.search}${location.hash}`;
  const pathnameForMatch = pathname.toLowerCase();
  const primarySegment = getPrimarySegment(pathnameForMatch);

  const quip = useMemo(() => {
    const index = hashString(attemptedPath) % quips.length;
    return quips[index];
  }, [attemptedPath]);

  const matches = useMemo(() => {
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

    scored.sort((a, b) => a.score - b.score);
    return scored;
  }, [pathnameForMatch, primarySegment]);

  const suggestedPages = useMemo(() => {
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

  const Wrapper = includeMain ? "main" : "section";

  return (
    <Wrapper
      className="bg-primary text-secondary px-8 pt-10 pb-32"
      aria-labelledby={titleId}
      aria-describedby={detailsId}
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className="grid gap-8 items-start lg:grid-cols-2">
          <Card className="p-8 outline-2 outline-accent text-left motion-reduce:animate-none">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
              <div className="h-16 w-16 rounded-pill bg-primary text-secondary flex items-center justify-center shrink-0">
                <Ghost size={30} aria-hidden="true" />
              </div>

              <div className="min-w-0">
                <p className="font-mono text-sm font-semibold uppercase tracking-widest text-accent">
                  Error 404
                </p>
                <h1
                  id={titleId}
                  className="mt-2 text-3xl font-bold tracking-tight"
                >
                  Page not found
                </h1>
                <p id={detailsId} className="mt-3 text-accent max-w-prose">
                  {quip}
                </p>

                <div className="mt-6">
                  <p className="text-sm text-accent">You tried to visit</p>
                  <code className="mt-2 block w-full overflow-x-auto rounded-large-element bg-primary/10 p-4 font-mono text-sm text-primary">
                    {attemptedPath || "/"}
                  </code>
                </div>

                {suggestedPages.length > 0 && (
                  <div className="mt-6 rounded-large-element bg-primary/10 p-6">
                    <h2 className="font-bold">Did you mean…</h2>
                    <p className="mt-2 text-sm text-accent max-w-prose">
                      We found a close match.
                    </p>
                    <ul className="mt-4 flex flex-wrap gap-3">
                      {suggestedPages.map((page) => (
                        <li key={page.to}>
                          <Link
                            to={page.to}
                            className="inline-flex items-center gap-2 rounded-pill bg-primary text-secondary px-4 py-2 text-sm font-medium motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
                          >
                            {page.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </Card>

          <Card className="p-8 outline-2 outline-accent text-left motion-reduce:animate-none">
            <h2 className="text-xl font-bold">Quick ways out</h2>
            <p className="mt-2 text-accent max-w-prose">
              Pick a safe page. No judgment. We’ve all clicked the wrong thing,
              blinked twice, and pretended it didn’t happen.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="inline-flex items-center gap-2 rounded-pill bg-primary text-secondary px-4 py-2 text-sm font-medium motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                <ArrowLeft size={18} aria-hidden="true" />
                Go back
              </button>

              <Link
                to="/"
                className="inline-flex items-center gap-2 rounded-pill bg-primary text-secondary px-4 py-2 text-sm font-medium motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary hover:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                <Home size={18} aria-hidden="true" />
                Home
              </Link>

              <Link
                to="/help"
                className="inline-flex items-center gap-2 rounded-pill bg-transparent text-primary px-4 py-2 text-sm font-medium outline-2 outline-accent motion-safe:transition-all hover:bg-primary hover:text-secondary hover:outline-0 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                <LifeBuoy size={18} aria-hidden="true" />
                Help
              </Link>
            </div>

            <div className="mt-8 rounded-large-element bg-primary/10 p-6">
              <h3 className="font-bold">
                If this surprised you (valid reaction)
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
                className="w-full flex items-center justify-between gap-3 rounded-large-element px-4 py-3 font-bold text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                <span>Highly scientific investigation (optional)</span>
                <ChevronDown
                  size={20}
                  aria-hidden="true"
                  className={`shrink-0 motion-safe:transition-transform duration-200 ${isInvestigationOpen ? "rotate-180" : "rotate-0"}`}
                />
              </button>

              <div
                id={investigationId}
                aria-hidden={!isInvestigationOpen}
                className={`overflow-hidden px-4 ${isInvestigationOpen ? "max-h-128 pb-4 opacity-100" : "max-h-0 pb-0 opacity-0"} motion-safe:transition-all motion-safe:duration-300 ease-out`}
              >
                <div className="pt-2 text-accent">
                  {bestMatch ? (
                    <p className="text-sm">
                      Close‑Enough‑O‑Meter:{" "}
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
                    <li>Bonus theory: it wandered off to find snacks.</li>
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

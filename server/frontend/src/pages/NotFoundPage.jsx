import { cn } from "@/lib/utils";
import { useEffect, useMemo, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronDown, Ghost, Home } from "lucide-react";

import { notfound as quips } from "../assets/greetings";

import Card from "../components/cards/Card";
import HeaderCard from "../components/cards/HeaderCard";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import {
  normalizePathname,
  pickStableQuip,
  scoreKnownPages,
} from "../utils/notFoundHelpers";

/* ======================================================================
   Known pages + safe quips
   ====================================================================== */

const knownPages = [
  { to: "/apps", label: "Apps" },
  { to: "/users", label: "Users" },
  { to: "/settings", label: "Settings" },
  { to: "/lore", label: "Lore" },
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

  const quip = useMemo(
    () => pickStableQuip(attemptedPath, SAFE_QUIPS),
    [attemptedPath],
  );

  // Score known routes for "close enough" suggestions (best match first).
  const matches = useMemo(
    () => scoreKnownPages(pathname, knownPages),
    [pathname],
  );

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
  // The “mystery grey line” is avoided by disabling the default focus outline on
  // the wrapper (Page shell, or the section's inline style in embedded mode).
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

  // Accordion a11y safety: when closed, keep it out of pointer interactions.
  // (No interactive elements inside today, but this prevents future foot-guns.)
  const panelA11yProps = isInvestigationOpen
    ? {}
    : /** @type {{ "aria-hidden"?: boolean, inert?: boolean }} */ ({
        "aria-hidden": true,
        inert: true,
      });

  const pageContent = (
    <>
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
            className="p-8 ring-2 ring-accent text-center motion-reduce:animate-none"
            leftContent={
              <div className="h-16 w-16 rounded-pill bg-primary text-secondary flex items-center justify-center shrink-0">
                <Ghost size={30} aria-hidden="true" />
              </div>
            }
            bottomContentClassName="text-left"
            bottomContent={
              <div className="flex flex-col gap-6">
                <div>
                  <p className="font-mono text-sm font-normal uppercase tracking-widest text-primary/70">
                    Error 404
                  </p>
                  <p id={detailsId} className="mt-3 text-primary/70 max-w-prose">
                    {quip}
                  </p>
                </div>

                <div>
                  <p className="text-sm text-primary/70">You tried to visit</p>
                  <code className="mt-2 block w-full overflow-x-auto rounded-large-element bg-primary/10 p-4 font-mono text-sm text-primary">
                    {attemptedPath || "/"}
                  </code>
                </div>

                {suggestedPages.length > 0 && (
                  <div className="rounded-large-element bg-primary/10 p-6">
                    <h2 className="font-mono font-normal">Did you mean…</h2>
                    <p className="mt-2 text-sm text-primary/70 max-w-prose">
                      We found a close match.
                    </p>
                    <ul className="mt-4 flex flex-wrap gap-3">
                      {suggestedPages.map((page) => (
                        <li key={page.to}>
                          <Button asChild variant="primary">
                            <Link to={page.to}>{page.label}</Link>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            }
          />

          <Card className="p-8 ring-2 ring-accent text-left motion-reduce:animate-none">
            <h2 className="text-xl font-mono font-normal block text-center">
              Quick Ways Out
            </h2>
            <p className="mt-2 text-primary/70 max-w-prose block text-center">
              Try a safe page. We won't judge! Well, the owl might...
            </p>

            <div className="mt-6 flex flex-wrap gap-3 justify-center">
              <Button type="button" variant="primary" onClick={handleGoBack}>
                <ArrowLeft size={18} aria-hidden="true" />
                Go back
              </Button>

              <Button asChild variant="primary">
                <Link to="/">
                  <Home size={18} aria-hidden="true" />
                  Home
                </Link>
              </Button>
            </div>

            <div className="mt-8 rounded-large-element bg-primary/10 p-6">
              <h3 className="font-mono font-normal">
                If This Surprised You (Valid Reaction)
              </h3>
              <ul className="mt-3 list-disc pl-5 text-primary/70 space-y-2">
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
                className={cn(
                  "w-full flex items-center justify-between gap-3 rounded-large-element px-4 py-3 font-bold text-left " +
                  "focus-visible:ring-2 focus:ring-accent focus:ring-offset-2",
                )}
              >
                <span>Highly Scientific Investigation (Optional)</span>
                <ChevronDown
                  size={20}
                  aria-hidden="true"
                  className={cn(
                    "shrink-0 motion-safe:transition-transform duration-200",
                    isInvestigationOpen ? "rotate-180" : "rotate-0",
                  )}
                />
              </button>

              <div
                id={investigationId}
                {...panelA11yProps}
                className={cn(
                  "overflow-hidden px-4",
                  isInvestigationOpen
                    ? "max-h-128 pb-4 opacity-100"
                    : "max-h-0 pb-0 opacity-0 pointer-events-none select-none",
                  "motion-safe:transition-all motion-safe:duration-300 ease-out",
                )}
              >
                <div className="pt-2 text-primary/70">
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
    </>
  );

  // Embedded mode (includeMain=false): the caller provides the page shell, so
  // render a plain section and keep the region labelling on it.
  if (!includeMain) {
    return (
      <section
        className="bg-primary text-secondary px-8 pt-10 pb-32"
        data-slot="not-found"
        aria-labelledby={regionTitleId}
        aria-describedby={detailsId}
        id="main-content"
        tabIndex={-1}
        style={{ outline: "none" }}
      >
        {pageContent}
      </section>
    );
  }

  return (
    <Page className="pt-10" data-slot="not-found">
      {pageContent}
    </Page>
  );
}

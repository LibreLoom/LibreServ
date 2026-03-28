import { useEffect, useMemo, useId } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Home, LifeBuoy, SearchX } from "lucide-react";

import { objectnotfound as quips } from "../assets/greetings";

import Card from "../components/common/cards/Card";
import HeaderCard from "../components/cards/HeaderCard";

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

function toTitleCase(value) {
  const label = String(value ?? "").trim();
  if (!label) return "Item";
  return label[0].toUpperCase() + label.slice(1);
}

/* ======================================================================
   Quips
   ====================================================================== */

const fallbackQuips = [
  "This record is missing. The pigeon left a note.",
  "We checked twice. The item is still not here.",
  "Not found. The pigeon swears it looked everywhere.",
];

// Resolve once; avoids modulo-by-zero and avoids hook dependency noise.
const SAFE_QUIPS =
  Array.isArray(quips) && quips.length > 0 ? quips : fallbackQuips;

/* ======================================================================
   Component
   ====================================================================== */

export default function ObjectNotFound({
  objectLabel = "item",
  objectName = "",
  backTo = "/",
  backLabel = "Home",
  backIcon: BackIcon = null,
  includeMain = true,
}) {
  const navigate = useNavigate();
  const regionTitleId = useId();
  const detailsId = useId();

  const nameValue = String(objectName ?? "").trim();
  const titleLabel = toTitleCase(objectLabel);
  const attemptedLabel = nameValue || "unknown";

  const quip = useMemo(() => {
    // Stable quip for a given missing object name.
    const hashTarget = `${titleLabel}:${attemptedLabel}`;
    const index = hashString(hashTarget) % SAFE_QUIPS.length;
    return SAFE_QUIPS[index];
  }, [titleLabel, attemptedLabel]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `404 - ${titleLabel} Not Found | LibreServ`;
    return () => {
      document.title = previousTitle;
    };
  }, [titleLabel]);

  // Focus the main region when landing on the missing-object page.
  useEffect(() => {
    const main = document.getElementById("main-content");
    if (main && typeof main.focus === "function") main.focus();
  }, [nameValue]);

  function handleGoBack() {
    // If there's history, go back. Otherwise, go to the provided fallback.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(backTo, { replace: true });
    }
  }

  const Wrapper = includeMain ? "main" : "section";

   // Shared button/link base class:
   // We use focus-visible:ring-* for keyboard focus indicators and apply ring utilities for hover/focus states.
    const solidPill =
      "inline-flex items-center gap-2 rounded-pill bg-primary text-secondary px-4 py-2 text-sm font-medium " +
      "motion-safe:transition-all hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary hover:ring-solid " +
      "focus-visible:ring-2 focus:ring-accent focus:ring-offset-2";

    const ghostPill =
      "inline-flex items-center gap-2 rounded-pill bg-transparent text-primary px-4 py-2 text-sm font-medium ring-2 ring-accent " +
      "motion-safe:transition-all hover:bg-primary hover:text-secondary hover:ring-0 " +
      "focus-visible:ring-2 focus:ring-accent focus:ring-offset-2";

  return (
     <Wrapper
       className="bg-primary text-secondary px-8 pt-10 pb-32 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
       aria-labelledby={regionTitleId}
       aria-describedby={detailsId}
       id="main-content"
       tabIndex={-1}
     >
      <span id={regionTitleId} className="sr-only">
        {titleLabel} Not Found
      </span>

      <div className="mx-auto w-full max-w-5xl">
        <div className="grid gap-8 items-start lg:grid-cols-2">
          <HeaderCard
            title={`${titleLabel} Not Found`}
            align="center"
            dynamicRounding={false}
             className="p-8 ring-2 ring-accent text-center motion-reduce:animate-none"
            leftContent={
              <div className="h-16 w-16 rounded-pill bg-primary text-secondary flex items-center justify-center shrink-0">
                <SearchX size={30} aria-hidden="true" />
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
                  <p className="text-sm text-accent">
                    We couldn't find this {objectLabel}
                  </p>
                  <code className="mt-2 block w-full overflow-x-auto rounded-large-element bg-primary/10 p-4 font-mono text-sm text-primary">
                    {attemptedLabel}
                  </code>
                </div>
              </div>
            }
          />

           <Card className="p-8 ring-2 ring-accent text-left motion-reduce:animate-none">
            <h2 className="text-xl font-mono font-normal block text-center">
              Quick Ways Out
            </h2>
            <p className="mt-2 text-accent max-w-prose block text-center">
              Try a safe page or jump back to the list. The pigeon will not
              judge.
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

              <Link to={backTo} className={solidPill}>
                {BackIcon ? <BackIcon size={18} aria-hidden="true" /> : null}
                {backLabel}
              </Link>

              <Link to="/" className={ghostPill}>
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
                If This Seems Wrong (and You're Probably Right)
              </h3>
              <ul className="mt-3 list-disc pl-5 text-accent space-y-2">
                <li>Double-check the ID or slug.</li>
                <li>Return to the list and open the item again.</li>
                <li>If you followed a link, it might be outdated.</li>
              </ul>
            </div>
          </Card>
        </div>
      </div>
    </Wrapper>
  );
}

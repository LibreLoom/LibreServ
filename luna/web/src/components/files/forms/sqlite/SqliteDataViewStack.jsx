/**
 * Table and Result share one grid cell.
 *
 * Both stay mounted so a switch cross-fades while the panels slide along the
 * segment's direction. The hidden panel is inert, hidden from assistive
 * technology, and click-through, so only the visible view is reachable.
 */

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";

// Hand-off, not a cross-fade: the outgoing view clears quickly and the
// incoming one starts just before it is gone, so the two never show through
// each other and the white table header never ghosts over the result.
const BASE = "motion-reduce:transition-none motion-reduce:delay-0";
const LEAVE = `${BASE} pointer-events-none opacity-0 transition-[opacity,translate] duration-[120ms] ease-[var(--motion-easing-emphasized-accelerate)]`;
const ENTER = `${BASE} translate-x-0 opacity-100 transition-[opacity,translate] delay-[90ms] duration-[var(--motion-duration-medium1)] ease-[var(--motion-easing-emphasized-decelerate)]`;

const EXIT_MS = 150;

/**
 * @param {{
 *   view: "table" | "query",
 *   hasResult: boolean,
 *   table: import("react").ReactNode,
 *   result?: import("react").ReactNode,
 * }} props
 */
export default function SqliteDataViewStack({
  view,
  hasResult,
  table,
  result,
}) {
  const showingResult = hasResult && view === "query";
  const [wasShowing, setWasShowing] = useState(showingResult);
  const [exiting, setExiting] = useState(false);
  const lastVisibleResult = useRef(/** @type {import("react").ReactNode} */ (null));
  if (showingResult) lastVisibleResult.current = result;
  else if (!wasShowing && !exiting) lastVisibleResult.current = null;
  if (showingResult !== wasShowing) {
    setWasShowing(showingResult);
    setExiting(!showingResult && !hasResult &&
      typeof window !== "undefined" &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }
  useEffect(() => {
    if (!exiting) return undefined;
    const timer = window.setTimeout(() => setExiting(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);
  return (
    <div className="grid min-h-0 flex-1 grid-rows-1 overflow-hidden px-4 pb-3">
      <div
        data-slot="sqlite-table-view"
        aria-hidden={showingResult || undefined}
        inert={showingResult || undefined}
        className={cn(
          "col-start-1 row-start-1 flex min-h-0 flex-col surface-primary",
          showingResult ? `${LEAVE} -translate-x-3` : ENTER,
        )}
      >
        {table}
      </div>
      {hasResult || exiting ? (
        <div
          data-slot="sqlite-result-view"
          aria-hidden={!showingResult || undefined}
          inert={!showingResult || undefined}
          onTransitionEnd={(event) => {
            if (exiting && event.target === event.currentTarget && event.propertyName === "opacity") {
              setExiting(false);
            }
          }}
          className={cn(
            "col-start-1 row-start-1 flex min-h-0 flex-col surface-primary",
            showingResult ? ENTER : `${LEAVE} translate-x-3`,
          )}
        >
          {hasResult ? result : lastVisibleResult.current}
        </div>
      ) : null}
    </div>
  );
}

SqliteDataViewStack.propTypes = {
  view: PropTypes.oneOf(["table", "query"]).isRequired,
  hasResult: PropTypes.bool.isRequired,
  table: PropTypes.node,
  result: PropTypes.node,
};

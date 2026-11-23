/**
 * Table and Result share one grid cell.
 *
 * Both stay mounted so a switch cross-fades while the panels slide along the
 * segment's direction. The hidden panel is inert, hidden from assistive
 * technology, and click-through, so only the visible view is reachable.
 */

import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";

const MOTION =
  "transition-[opacity,translate] duration-[var(--motion-duration-short4)] ease-[var(--motion-easing-emphasized-decelerate)] motion-reduce:transition-none";

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
  return (
    <div className="grid min-h-0 flex-1 grid-rows-1 overflow-hidden px-4 pb-3">
      <div
        data-slot="sqlite-table-view"
        aria-hidden={showingResult || undefined}
        inert={showingResult || undefined}
        className={cn(
          "col-start-1 row-start-1 flex min-h-0 flex-col surface-primary",
          MOTION,
          showingResult
            ? "pointer-events-none -translate-x-2 opacity-0"
            : "translate-x-0 opacity-100",
        )}
      >
        {table}
      </div>
      {hasResult ? (
        <div
          data-slot="sqlite-result-view"
          aria-hidden={!showingResult || undefined}
          inert={!showingResult || undefined}
          className={cn(
            "col-start-1 row-start-1 flex min-h-0 flex-col surface-primary",
            MOTION,
            showingResult
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-2 opacity-0",
          )}
        >
          {result}
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

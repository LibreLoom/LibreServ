/**
 * Table and Result share one grid cell.
 *
 * Both stay mounted so a switch cross-fades while the panels slide along the
 * segment's direction. The hidden panel is inert, hidden from assistive
 * technology, and click-through, so only the visible view is reachable.
 */

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@libreloom/ui/lib/utils.js";

// Hand-off, not a cross-fade: the outgoing view clears quickly and the
// incoming one starts just before it is gone, so the two never show through
// each other and the white table header never ghosts over the result.
const BASE =
  "will-change-[opacity,translate] motion-reduce:transition-none motion-reduce:delay-0";
const LEAVE = `${BASE} pointer-events-none opacity-0 transition-[opacity,translate] duration-[120ms] ease-[var(--motion-easing-emphasized-accelerate)]`;
const ENTER = `${BASE} translate-x-0 opacity-100 transition-[opacity,translate] delay-[90ms] duration-[var(--motion-duration-medium1)] ease-[var(--motion-easing-emphasized-decelerate)]`;

/**
 * A result pane that first appears already selected would mount at its final
 * state and snap in. Arm it one frame later so it animates like a switch.
 *
 * @param {boolean} showing
 */
function useArmed(showing) {
  const [armed, setArmed] = useState(!showing);
  useEffect(() => {
    if (armed) return undefined;
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [armed]);
  return armed;
}

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
  const resultArmed = useArmed(showingResult);
  const resultVisible = showingResult && resultArmed;
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
      {hasResult ? (
        <div
          data-slot="sqlite-result-view"
          aria-hidden={!resultVisible || undefined}
          inert={!resultVisible || undefined}
          className={cn(
            "col-start-1 row-start-1 flex min-h-0 flex-col surface-primary",
            resultVisible ? ENTER : `${LEAVE} translate-x-3`,
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

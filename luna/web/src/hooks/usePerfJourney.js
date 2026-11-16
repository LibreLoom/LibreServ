import { useEffect, useLayoutEffect, useRef } from "react";
import { perfEndAfterPaint, perfStart } from "../lib/perf.js";

/**
 * Time a journey that restarts whenever `key` changes (a folder path, a
 * route) and ends once `ready` is true for that key and the frame has
 * painted. A start the spec or a click marked just before is kept, and the
 * start is dated from the click or key press that caused it.
 *
 * @param {string} id journey ID from luna/perf/budgets.json
 * @param {string | null} key what is being opened; null pauses timing
 * @param {boolean} ready the screen shows what `key` asked for
 */
export default function usePerfJourney(id, key, ready) {
  const endedFor = useRef(/** @type {string | null} */ (null));

  useLayoutEffect(() => {
    if (key == null) return;
    endedFor.current = null;
    perfStart(id, { fromInput: true, keep: true });
  }, [id, key]);

  useEffect(() => {
    if (key == null || !ready || endedFor.current === key) return;
    endedFor.current = key;
    perfEndAfterPaint(id);
  }, [id, key, ready]);
}

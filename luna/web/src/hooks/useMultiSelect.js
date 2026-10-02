import { useCallback, useMemo, useRef, useState } from "react";

/**
 * @param {unknown} item
 * @returns {string}
 */
export function photoSelectionKey(item) {
  if (!item || typeof item !== "object") return "";
  const drive = /** @type {{ drive_id?: string, path?: string }} */ (item).drive_id || "";
  const path = /** @type {{ drive_id?: string, path?: string }} */ (item).path || "";
  return `${drive}\0${path}`;
}

/**
 * Multi-select for photo grids: toggle, range (shift), select-all-in-view, clear.
 *
 * @param {{
 *   items?: object[],
 *   keyOf?: (item: object) => string,
 * }} [opts]
 */
export default function useMultiSelect({ items = [], keyOf = photoSelectionKey } = {}) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(/** @type {Set<string>} */ (new Set()));
  // The range anchor and the visible keys live in refs so `toggle` keeps one
  // identity for the whole session — a toggle that changed on every click would
  // re-render every thumbnail in the grid.
  const anchorRef = useRef(/** @type {string|null} */ (null));

  const keysInView = useMemo(() => items.map((item) => keyOf(item)).filter(Boolean), [items, keyOf]);
  const keysInViewRef = useRef(keysInView);
  keysInViewRef.current = keysInView;

  const clear = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  const exit = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  const enter = useCallback(() => {
    setSelectMode(true);
  }, []);

  const toggle = useCallback(
    (item, { range = false } = {}) => {
      const key = keyOf(item);
      if (!key) return;
      setSelectMode(true);
      // Read before the updater runs: it executes later, after the anchor moves.
      const keys = keysInViewRef.current;
      const anchorKey = anchorRef.current;
      setSelected((prev) => {
        const next = new Set(prev);
        if (range && anchorKey && keys.includes(anchorKey)) {
          const a = keys.indexOf(anchorKey);
          const b = keys.indexOf(key);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i += 1) next.add(keys[i]);
            return next;
          }
        }
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      anchorRef.current = key;
    },
    [keyOf],
  );

  const selectAllInView = useCallback(() => {
    setSelectMode(true);
    setSelected(new Set(keysInView));
  }, [keysInView]);

  /** Select a specific list of items (e.g. one day in the timeline). */
  const selectItems = useCallback(
    (list) => {
      setSelectMode(true);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const item of list || []) {
          const key = keyOf(item);
          if (key) next.add(key);
        }
        return next;
      });
    },
    [keyOf],
  );

  /** Deselect a specific list of items (e.g. one day in the timeline). */
  const deselectItems = useCallback(
    (list) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const item of list || []) {
          const key = keyOf(item);
          if (key) next.delete(key);
        }
        return next;
      });
    },
    [keyOf],
  );

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(keyOf(item))),
    [items, keyOf, selected],
  );

  const isSelected = useCallback((item) => selected.has(keyOf(item)), [keyOf, selected]);

  return {
    selectMode,
    selected,
    selectedCount: selected.size,
    selectedItems,
    isSelected,
    enter,
    exit,
    clear,
    toggle,
    selectAllInView,
    selectItems,
    deselectItems,
    setSelectMode,
  };
}

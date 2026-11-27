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

  const view = useMemo(() => {
    const keys = items.map((item) => keyOf(item));
    /** @type {Map<string, number>} */
    const indices = new Map();
    let hasDuplicates = false;
    keys.forEach((key, index) => {
      if (!key) return;
      if (indices.has(key)) hasDuplicates = true;
      else indices.set(key, index);
    });
    return { keys, indices, hasDuplicates };
  }, [items, keyOf]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const indexOfKey = useCallback((key) => view.indices.get(key) ?? -1, [view]);

  const clear = useCallback(() => {
    setSelected((previous) => previous.size ? new Set() : previous);
    anchorRef.current = null;
  }, []);

  const exit = useCallback(() => {
    setSelectMode(false);
    setSelected((previous) => previous.size ? new Set() : previous);
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
      const { keys, indices } = viewRef.current;
      const anchorKey = anchorRef.current;
      setSelected((prev) => {
        if (range && anchorKey) {
          const a = indices.get(anchorKey);
          const b = indices.get(key);
          if (a !== undefined && b !== undefined) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            let next = prev;
            for (let i = lo; i <= hi; i += 1) {
              if (!keys[i] || next.has(keys[i])) continue;
              if (next === prev) next = new Set(prev);
              next.add(keys[i]);
            }
            return next;
          }
        }
        const next = new Set(prev);
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
    setSelected(new Set(view.indices.keys()));
  }, [view]);

  /** Select a specific list of items (e.g. one day in the timeline). */
  const selectItems = useCallback(
    (list) => {
      setSelectMode(true);
      setSelected((prev) => {
        let next = prev;
        for (const item of list || []) {
          const key = keyOf(item);
          if (!key || next.has(key)) continue;
          if (next === prev) next = new Set(prev);
          next.add(key);
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
        let next = prev;
        for (const item of list || []) {
          const key = keyOf(item);
          if (!key || !next.has(key)) continue;
          if (next === prev) next = new Set(prev);
          next.delete(key);
        }
        return next;
      });
    },
    [keyOf],
  );

  // Only bulk actions need the items themselves. Keep the library scan off
  // the selection path and resolve in view order when an action is invoked.
  const getSelectedItems = useCallback(
    () => {
      if (!selected.size) return [];
      if (view.hasDuplicates || selected.size * 8 > items.length) {
        return items.filter((_item, index) => selected.has(view.keys[index]));
      }
      const positions = [];
      for (const key of selected) {
        const index = view.indices.get(key);
        if (index !== undefined) positions.push(index);
      }
      positions.sort((a, b) => a - b);
      return positions.map((index) => items[index]);
    },
    [items, selected, view],
  );

  const isSelected = useCallback((item) => selected.has(keyOf(item)), [keyOf, selected]);

  return {
    selectMode,
    selected,
    selectedCount: selected.size,
    getSelectedItems,
    indexOfKey,
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

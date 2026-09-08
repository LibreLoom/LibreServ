import { useCallback, useMemo, useState } from "react";

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
  const [anchorKey, setAnchorKey] = useState(/** @type {string|null} */ (null));

  const keysInView = useMemo(() => items.map((item) => keyOf(item)).filter(Boolean), [items, keyOf]);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchorKey(null);
  }, []);

  const exit = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
    setAnchorKey(null);
  }, []);

  const enter = useCallback(() => {
    setSelectMode(true);
  }, []);

  const toggle = useCallback(
    (item, { range = false } = {}) => {
      const key = keyOf(item);
      if (!key) return;
      setSelectMode(true);
      setSelected((prev) => {
        const next = new Set(prev);
        if (range && anchorKey && keysInView.includes(anchorKey)) {
          const a = keysInView.indexOf(anchorKey);
          const b = keysInView.indexOf(key);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i += 1) next.add(keysInView[i]);
            return next;
          }
        }
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      setAnchorKey(key);
    },
    [anchorKey, keyOf, keysInView],
  );

  const selectAllInView = useCallback(() => {
    setSelectMode(true);
    setSelected(new Set(keysInView));
  }, [keysInView]);

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
    setSelectMode,
  };
}

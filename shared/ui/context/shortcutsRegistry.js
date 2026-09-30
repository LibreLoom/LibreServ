/* eslint-disable react-refresh/only-export-components -- context and hooks live together */
import { createContext, useContext, useEffect, useRef } from "react";
import { parseCombo } from "../lib/shortcuts.js";

/**
 * @typedef {object} ShortcutOptions
 * @property {string} label What it does, in plain words. Shown in the `?` sheet.
 * @property {string} [group] Heading in the `?` sheet.
 * @property {number} [priority] Higher wins when two shortcuts share a key
 *   (a page's own search over the global one). Default 0.
 * @property {boolean} [enabled] Default true.
 * @property {boolean} [hidden] Work, but stay out of the `?` sheet.
 * @property {boolean} [allowInInput] Fire while a text field has focus.
 *   Default: only combos that use Alt.
 * @property {boolean} [allowInModal] Fire while a dialog is open. Default false.
 * @property {boolean} [repeat] Fire again while the key is held. Default false.
 */

/**
 * @typedef {object} Registration
 * @property {number} id
 * @property {string[]} keys
 * @property {ReturnType<typeof parseCombo>[]} combos
 * @property {{ current: (event: KeyboardEvent) => unknown }} handlerRef
 * @property {string} label
 * @property {string} group
 * @property {number} priority
 * @property {boolean} enabled
 * @property {boolean} hidden
 * @property {boolean | undefined} allowInInput
 * @property {boolean} allowInModal
 * @property {boolean} repeat
 */

export const ShortcutsContext = createContext(
  /** @type {{ register: (r: Omit<Registration, "id">) => () => void, list: () => Registration[], openSheet: () => void } | null} */ (null),
);

/**
 * Registers a keyboard shortcut for as long as the calling component is mounted.
 * A no-op outside a `ShortcutsProvider`, so components stay testable alone.
 * The handler may return `false` to pass the key to the next matching shortcut.
 *
 * @param {string | string[]} keys Combos like "/", "Alt+Shift+1", "Mod+Enter".
 * @param {(event: KeyboardEvent) => unknown} handler
 * @param {ShortcutOptions} options
 */
export function useShortcut(keys, handler, options) {
  const ctx = useContext(ShortcutsContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  const keyList = Array.isArray(keys) ? keys : [keys];
  const keyId = keyList.join("|");
  const {
    label,
    group = "General",
    priority = 0,
    enabled = true,
    hidden = false,
    allowInInput,
    allowInModal = false,
    repeat = false,
  } = options;

  useEffect(() => {
    if (!ctx || !enabled) return undefined;
    const list = keyId.split("|");
    return ctx.register({
      keys: list,
      combos: list.map(parseCombo),
      handlerRef,
      label,
      group,
      priority,
      enabled,
      hidden,
      allowInInput,
      allowInModal,
      repeat,
    });
  }, [ctx, keyId, label, group, priority, enabled, hidden, allowInInput, allowInModal, repeat]);
}

/** Opens the `?` shortcuts sheet. Null outside a provider. */
export function useShortcutsSheet() {
  const ctx = useContext(ShortcutsContext);
  return ctx ? { open: ctx.openSheet } : null;
}

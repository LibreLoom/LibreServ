import { useCallback, useEffect, useRef, useState } from "react";
import { HOVER_INTENT } from "../lib/ui-tokens.js";

/**
 * Open-while-hovered state for a container, with hover intent.
 *
 * - Mouse: opens after `openMs` resting on it, closes `closeMs` after leaving.
 *   Touch and pen are ignored — give them a tap path instead.
 * - Keyboard: focus moving in opens at once, focus moving out closes.
 * - Escape closes and puts focus on `returnFocusRef`, since whatever was
 *   focused inside may stop being reachable once it closes.
 *
 * Spread `handlers` onto the container element.
 *
 * @param {{
 *   openMs?: number,
 *   closeMs?: number,
 *   returnFocusRef?: import("react").RefObject<HTMLElement | null>,
 * }} [options]
 */
export function useHoverIntent({
  openMs = HOVER_INTENT.openMs,
  closeMs = HOVER_INTENT.closeMs,
  returnFocusRef,
} = {}) {
  const [open, setOpen] = useState(false);
  const timer = useRef(/** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined));

  const schedule = useCallback((next, delay) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** @param {import("react").FocusEvent} e */
  const fromOutside = (e) => !e.currentTarget.contains(/** @type {Node | null} */ (e.relatedTarget));

  const handlers = {
    /** @param {import("react").PointerEvent} e */
    onPointerEnter: (e) => {
      if (e.pointerType === "mouse") schedule(true, openMs);
    },
    /** @param {import("react").PointerEvent} e */
    onPointerLeave: (e) => {
      if (e.pointerType === "mouse") schedule(false, closeMs);
    },
    /** @param {import("react").FocusEvent} e */
    onFocus: (e) => {
      if (fromOutside(e)) schedule(true, 0);
    },
    /** @param {import("react").FocusEvent} e */
    onBlur: (e) => {
      if (fromOutside(e)) schedule(false, 0);
    },
    /** @param {import("react").KeyboardEvent} e */
    onKeyDown: (e) => {
      if (e.key !== "Escape" || !open) return;
      clearTimeout(timer.current);
      setOpen(false);
      returnFocusRef?.current?.focus();
    },
  };

  return { open, handlers };
}

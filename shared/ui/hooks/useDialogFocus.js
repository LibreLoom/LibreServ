import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Every visible modal dialog; the last one is on top. */
function openModals() {
  return [...document.querySelectorAll('[aria-modal="true"]')];
}

/**
 * Keyboard and screen-reader behavior for a full-screen dialog that is not a
 * ModalCard (a photo viewer, say): focus moves in when it opens, Tab stays
 * inside, the page behind is made inert, and focus goes back to whatever
 * opened it when it closes.
 *
 * Only the app root is made inert: tooltips and toasts portal to the body
 * and must stay usable. A ModalCard opened on top of this dialog takes over
 * Tab, so the trap yields to it.
 *
 * @param {import("react").RefObject<HTMLElement | null>} dialogRef the element with role="dialog"
 * @param {{ active?: boolean, initialFocusRef?: import("react").RefObject<HTMLElement | null>, inertSelector?: string }} [opts]
 */
export default function useDialogFocus(dialogRef, { active = true, initialFocusRef, inertSelector = "#root" } = {}) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!active || !dialog) return undefined;

    const opener = /** @type {HTMLElement | null} */ (document.activeElement);

    const root = document.querySelector(inertSelector);
    const madeInert = Boolean(root && !root.contains(dialog) && !root.hasAttribute("inert"));
    if (madeInert) root.setAttribute("inert", "");

    const first = initialFocusRef?.current || dialog.querySelector(FOCUSABLE);
    if (first instanceof HTMLElement) {
      first.focus();
    } else {
      dialog.tabIndex = -1;
      dialog.focus();
    }

    const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
      if (event.key !== "Tab") return;
      const top = openModals().at(-1);
      if (top && top !== dialog && !dialog.contains(top)) return;
      const focusable = [...dialog.querySelectorAll(FOCUSABLE)].filter(
        (el) => typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true }),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const at = document.activeElement;
      if (!dialog.contains(at)) {
        event.preventDefault();
        /** @type {HTMLElement} */ (event.shiftKey ? lastEl : firstEl).focus();
      } else if (event.shiftKey && at === firstEl) {
        event.preventDefault();
        /** @type {HTMLElement} */ (lastEl).focus();
      } else if (!event.shiftKey && at === lastEl) {
        event.preventDefault();
        /** @type {HTMLElement} */ (firstEl).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (madeInert) root.removeAttribute("inert");
      if (opener?.isConnected) opener.focus();
    };
  }, [dialogRef, active, initialFocusRef, inertSelector]);
}

/**
 * Tooltip — hover/focus/tap glosses for real words, not baby talk.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONVENTION — InfoHint vs TermHint vs Callout
 * ═══════════════════════════════════════════════════════════════════════
 *
 * InfoHint  — ⓘ next to a label, badge, or heading. Longer explanation
 *             (a role, why a field exists, what happens next).
 * TermHint  — wrap one word or short phrase in a sentence. Smaller popup.
 * Callout   — persistent inline help the user must read without hovering.
 *
 * Never replace "router", "ethernet", "admin", or "read" with a metaphor.
 * Gloss the term. See AGENTS.md → PLAIN LANGUAGE / WALL OF SHAME.
 *
 * SURFACE PROP — names the BACKDROP the trigger sits on
 *    "primary"   page background → trigger uses text-secondary
 *    "secondary" card/modal      → trigger uses text-primary (default)
 *
 * Open on hover (50ms), keyboard focus, and click/tap (phones).
 * The popup pops in over 50ms (`tooltip-pop-in`). Escape, outside tap,
 * and leaving both trigger and popup close it.
 *
 * @typedef {object} HintSharedProps
 * @property {import("react").ReactNode} content Popup body.
 * @property {"primary"|"secondary"} [surface]
 * @property {number} [delayMs] Hover open delay. Default 50. Use 0 in tests.
 * @property {string} [className]
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

/**
 * @param {HTMLElement} trigger
 * @param {HTMLElement} popup
 */
function placePopup(trigger, popup) {
  const gap = 8;
  const tr = trigger.getBoundingClientRect();
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  let top = tr.top - ph - gap;
  if (top < 8) top = tr.bottom + gap;
  let left = tr.left + tr.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  if (top + ph > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - ph - 8);
  }
  return { top, left };
}

/**
 * @param {{
 *   content: import("react").ReactNode,
 *   surface?: "primary"|"secondary",
 *   delayMs?: number,
 *   className?: string,
 *   popupClassName: string,
 *   dataSlot: string,
 *   renderTrigger: (args: {
 *     triggerRef: import("react").RefObject<HTMLElement>,
 *     open: boolean,
 *     tooltipId: string,
 *     onClick: (e: import("react").MouseEvent) => void,
 *     onPointerEnter: () => void,
 *     onPointerLeave: () => void,
 *     onFocus: () => void,
 *     onBlur: (e: import("react").FocusEvent) => void,
 *     textClass: string,
 *   }) => import("react").ReactNode,
 * }} props
 */
function HintShell({
  content,
  surface = "secondary",
  delayMs = 50,
  className = "",
  popupClassName,
  dataSlot,
  renderTrigger,
}) {
  const tooltipId = useId();
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState(/** @type {{ top: number, left: number } | null} */ (null));
  const textClass = surface === "primary" ? "text-secondary" : "text-primary";

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const show = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const hide = useCallback(() => {
    clearTimers();
    setPinned(false);
    setOpen(false);
  }, [clearTimers]);

  const scheduleShow = useCallback(() => {
    clearTimers();
    if (delayMs <= 0) {
      setOpen(true);
      return;
    }
    openTimer.current = setTimeout(() => setOpen(true), delayMs);
  }, [clearTimers, delayMs]);

  const scheduleHide = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => {
      setPinned(false);
      setOpen(false);
    }, 120);
  }, [clearTimers]);

  const updatePosition = useCallback(() => {
    if (triggerRef.current && popupRef.current) {
      setCoords(placePopup(triggerRef.current, popupRef.current));
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition, content]);

  useEffect(() => {
    if (!open) return;
    function onKey(event) {
      if (event.key === "Escape") {
        hide();
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(event) {
      const t = event.target;
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      hide();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, hide, updatePosition]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (open && pinned) hide();
    else {
      clearTimers();
      setPinned(true);
      setOpen(true);
    }
  };

  const onBlur = (event) => {
    const next = event.relatedTarget;
    if (popupRef.current?.contains(next) || triggerRef.current?.contains(next)) return;
    if (!pinned) hide();
  };

  return (
    <span className={cn("relative inline-flex items-center", className)} data-slot={dataSlot}>
      {renderTrigger({
        triggerRef,
        open,
        tooltipId,
        onClick,
        onPointerEnter: scheduleShow,
        onPointerLeave: pinned ? undefined : scheduleHide,
        onFocus: show,
        onBlur,
        textClass,
      })}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={tooltipId}
            role="tooltip"
            data-slot="tooltip-popup"
            onPointerEnter={show}
            onPointerLeave={pinned ? undefined : scheduleHide}
            style={{
              position: "fixed",
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              visibility: coords ? "visible" : "hidden",
            }}
            className={cn(
              "z-50 bg-secondary text-primary ring-2 ring-inset ring-accent",
              coords && "tooltip-pop-in",
              popupClassName,
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

HintShell.propTypes = {
  content: PropTypes.node.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  delayMs: PropTypes.number,
  className: PropTypes.string,
  popupClassName: PropTypes.string.isRequired,
  dataSlot: PropTypes.string.isRequired,
  renderTrigger: PropTypes.func.isRequired,
};

/**
 * ⓘ for a longer explanation next to a label or badge.
 *
 * @param {HintSharedProps & { label?: string }} props
 */
export function InfoHint({ content, surface = "secondary", delayMs, className, label = "More about this" }) {
  return (
    <HintShell
      content={content}
      surface={surface}
      delayMs={delayMs}
      className={cn("align-middle", className)}
      dataSlot="info-hint"
      popupClassName="max-w-sm rounded-large-element px-4 py-3 text-sm leading-relaxed"
      renderTrigger={({
        triggerRef,
        open,
        tooltipId,
        onClick,
        onPointerEnter,
        onPointerLeave,
        onFocus,
        onBlur,
        textClass,
      }) => (
        <button
          ref={triggerRef}
          type="button"
          data-slot="info-hint-trigger"
          aria-label={label}
          aria-expanded={open}
          aria-describedby={open ? tooltipId : undefined}
          onClick={onClick}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onFocus={onFocus}
          onBlur={onBlur}
          className={cn(
            "inline-flex items-center justify-center size-5 rounded-pill shrink-0",
            "cursor-help no-focus-outline",
            "focus-visible:ring-2 focus-visible:ring-accent",
            "hover:bg-accent/20 motion-safe:transition-colors motion-safe:duration-150",
            textClass,
          )}
        >
          <Info size={14} aria-hidden="true" />
        </button>
      )}
    />
  );
}

InfoHint.propTypes = {
  content: PropTypes.node.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  delayMs: PropTypes.number,
  className: PropTypes.string,
  label: PropTypes.string,
};

/**
 * Smaller popup over a single word or short phrase in a sentence.
 *
 * @param {HintSharedProps & { children: import("react").ReactNode }} props
 */
export function TermHint({ children, content, surface = "secondary", delayMs, className }) {
  return (
    <HintShell
      content={content}
      surface={surface}
      delayMs={delayMs}
      className={className}
      dataSlot="term-hint"
      popupClassName="max-w-xs rounded-pill px-3 py-1.5 text-xs leading-snug"
      renderTrigger={({
        triggerRef,
        open,
        tooltipId,
        onClick,
        onPointerEnter,
        onPointerLeave,
        onFocus,
        onBlur,
        textClass,
      }) => (
        <button
          ref={triggerRef}
          type="button"
          data-slot="term-hint-trigger"
          aria-expanded={open}
          aria-describedby={open ? tooltipId : undefined}
          onClick={onClick}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onFocus={onFocus}
          onBlur={onBlur}
          className={cn(
            "inline p-0 m-0 border-0 bg-transparent cursor-help font-[inherit]",
            "underline decoration-dotted decoration-2 underline-offset-4",
            "rounded-sm no-focus-outline",
            "focus-visible:ring-2 focus-visible:ring-accent",
            textClass,
          )}
        >
          {children}
        </button>
      )}
    />
  );
}

TermHint.propTypes = {
  children: PropTypes.node.isRequired,
  content: PropTypes.node.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  delayMs: PropTypes.number,
  className: PropTypes.string,
};

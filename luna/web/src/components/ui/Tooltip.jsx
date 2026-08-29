/**
 * Tooltip — hover/focus/tap glosses for real words, not baby talk.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONVENTION — InfoHint vs TermHint vs Callout vs Tooltip
 * ═══════════════════════════════════════════════════════════════════════
 *
 * InfoHint  — ⓘ next to a label, badge, or heading. Longer explanation
 *             (a role, why a field exists, what happens next).
 * TermHint  — wrap one word or short phrase in a sentence. Smaller popup.
 * Tooltip   — short label for icon buttons / toolbar actions. Does not
 *             steal click (the control still runs). Pair with aria-label.
 * Callout   — persistent inline help the user must read without hovering.
 *
 * TooltipProvider / ActionTooltipGroup — wrap a row of Tooltips so the
 * first open waits (hesitation), then siblings open immediately until the
 * pointer leaves the group long enough for the grace window to end.
 *
 * Never replace "router", "ethernet", "admin", or "read" with a metaphor.
 * Gloss the term. See AGENTS.md → PLAIN LANGUAGE / WALL OF SHAME.
 *
 * SURFACE PROP — names the BACKDROP the trigger sits on
 *    "primary"   page background → trigger uses text-secondary
 *    "secondary" card/modal      → trigger uses text-primary (default)
 *
 * Open on hover (short delay), keyboard focus, and click/tap (phones).
 * Escape, outside tap, and leaving both trigger and popup close it.
 *
 * @typedef {object} HintSharedProps
 * @property {import("react").ReactNode} content Popup body.
 * @property {"primary"|"secondary"} [surface]
 * @property {number} [delayMs] Hover open delay. Default 180. Use 0 in tests.
 * @property {string} [className]
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";

/** @type {import("react").Context<null | {
 *   delayMs: number,
 *   leaveGraceMs: number,
 *   activeId: string | null,
 *   isWarm: () => boolean,
 *   requestOpen: (id: string) => void,
 *   requestClose: (id: string) => void,
 * }>} */
const TooltipGroupContext = createContext(null);

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
 *     triggerRef: import("react").RefObject<HTMLButtonElement | null>,
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
  delayMs = 180,
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
  const [position, setPosition] = useState({ top: 0, left: 0 });
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
      setPosition(placePopup(triggerRef.current, popupRef.current));
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
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
    <span className={cn("relative inline-flex items-baseline", className)} data-slot={dataSlot}>
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
            style={{ position: "fixed", top: position.top, left: position.left }}
            className={cn(
              "z-50 bg-secondary text-primary ring-2 ring-inset ring-accent",
              "motion-safe:transition-opacity motion-safe:duration-150",
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
      popupClassName="max-w-xs rounded-large-element px-3 py-1.5 text-xs leading-snug"
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

/**
 * Scopes skip-delay / “warm” behavior for a cluster of Tooltips (e.g. a
 * row of icon actions). First hover waits `delayMs`; after one is open,
 * siblings open immediately until the pointer leaves long enough for
 * `leaveGraceMs` to elapse.
 *
 * @param {{
 *   children: import("react").ReactNode,
 *   delayMs?: number,
 *   leaveGraceMs?: number,
 *   className?: string,
 * }} props
 */
export function TooltipProvider({ children, delayMs = 400, leaveGraceMs = 300, className = "" }) {
  const [activeId, setActiveId] = useState(/** @type {string | null} */ (null));
  const warmRef = useRef(false);
  const graceTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const clearGrace = useCallback(() => {
    if (graceTimer.current) clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  useEffect(() => () => clearGrace(), [clearGrace]);

  const requestOpen = useCallback(
    (id) => {
      clearGrace();
      warmRef.current = true;
      setActiveId(id);
    },
    [clearGrace],
  );

  const requestClose = useCallback(
    (id) => {
      setActiveId((prev) => {
        if (prev !== id) return prev;
        clearGrace();
        graceTimer.current = setTimeout(() => {
          warmRef.current = false;
          graceTimer.current = null;
        }, leaveGraceMs);
        return null;
      });
    },
    [clearGrace, leaveGraceMs],
  );

  const isWarm = useCallback(() => warmRef.current || activeId != null, [activeId]);

  const value = useMemo(
    () => ({
      delayMs,
      leaveGraceMs,
      activeId,
      isWarm,
      requestOpen,
      requestClose,
    }),
    [delayMs, leaveGraceMs, activeId, isWarm, requestOpen, requestClose],
  );

  return (
    <TooltipGroupContext.Provider value={value}>
      <div className={cn("contents", className)} data-slot="tooltip-provider">
        {children}
      </div>
    </TooltipGroupContext.Provider>
  );
}

TooltipProvider.propTypes = {
  children: PropTypes.node.isRequired,
  delayMs: PropTypes.number,
  leaveGraceMs: PropTypes.number,
  className: PropTypes.string,
};

/** Action-row alias — same as TooltipProvider with action-oriented defaults. */
export function ActionTooltipGroup({ children, delayMs = 400, leaveGraceMs = 300, className = "" }) {
  return (
    <TooltipProvider delayMs={delayMs} leaveGraceMs={leaveGraceMs} className={className}>
      {children}
    </TooltipProvider>
  );
}

ActionTooltipGroup.propTypes = {
  children: PropTypes.node.isRequired,
  delayMs: PropTypes.number,
  leaveGraceMs: PropTypes.number,
  className: PropTypes.string,
};

/**
 * Short label popup for an icon button or other control. Does not pin or
 * steal clicks — the child still receives the action. Prefer wrapping
 * with ActionTooltipGroup when several icons sit in one toolbar row.
 *
 * @param {{
 *   content: import("react").ReactNode,
 *   children: import("react").ReactNode,
 *   surface?: "primary"|"secondary",
 *   delayMs?: number,
 *   className?: string,
 * }} props
 */
export function Tooltip({ content, children, surface: _surface = "secondary", delayMs, className = "" }) {
  const group = useContext(TooltipGroupContext);
  const localId = useId();
  const tooltipId = useId();
  const triggerRef = useRef(/** @type {HTMLElement | null} */ (null));
  const popupRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const openTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const closeTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const [soloOpen, setSoloOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const open = group ? group.activeId === localId : soloOpen;
  const resolvedDelay = delayMs ?? group?.delayMs ?? 400;

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const showNow = useCallback(() => {
    clearTimers();
    if (group) group.requestOpen(localId);
    else setSoloOpen(true);
  }, [clearTimers, group, localId]);

  const hideNow = useCallback(() => {
    clearTimers();
    if (group) group.requestClose(localId);
    else setSoloOpen(false);
  }, [clearTimers, group, localId]);

  const scheduleShow = useCallback(() => {
    clearTimers();
    const warm = group ? group.isWarm() : false;
    const wait = warm ? 0 : resolvedDelay;
    if (wait <= 0) {
      showNow();
      return;
    }
    openTimer.current = setTimeout(showNow, wait);
  }, [clearTimers, group, resolvedDelay, showNow]);

  const scheduleHide = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(hideNow, 120);
  }, [clearTimers, hideNow]);

  const updatePosition = useCallback(() => {
    if (triggerRef.current && popupRef.current) {
      setPosition(placePopup(triggerRef.current, popupRef.current));
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, content]);

  useEffect(() => {
    if (!open) return;
    function onKey(event) {
      if (event.key === "Escape") hideNow();
    }
    function onPointerDown(event) {
      const t = event.target;
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      hideNow();
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
  }, [open, hideNow, updatePosition]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  // Close when another tooltip in the group becomes active.
  useEffect(() => {
    if (!group) return;
    if (group.activeId != null && group.activeId !== localId) {
      clearTimers();
    }
  }, [group, localId, clearTimers]);

  return (
    <span
      ref={triggerRef}
      className={cn("relative inline-flex", className)}
      data-slot="tooltip"
      onPointerEnter={scheduleShow}
      onPointerLeave={scheduleHide}
      onFocusCapture={showNow}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (triggerRef.current?.contains(next) || popupRef.current?.contains(next)) return;
        hideNow();
      }}
      onClick={hideNow}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={tooltipId}
            role="tooltip"
            data-slot="tooltip-popup"
            onPointerEnter={showNow}
            onPointerLeave={scheduleHide}
            style={{ position: "fixed", top: position.top, left: position.left }}
            className={cn(
              "z-50 bg-secondary text-primary ring-2 ring-inset ring-accent",
              "max-w-xs rounded-large-element px-3 py-1.5 text-xs leading-snug pointer-events-auto",
              "motion-safe:transition-opacity motion-safe:duration-150",
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

Tooltip.propTypes = {
  content: PropTypes.node.isRequired,
  children: PropTypes.node.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  delayMs: PropTypes.number,
  className: PropTypes.string,
};

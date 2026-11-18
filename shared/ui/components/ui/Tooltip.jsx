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
 * Open on hover (short delay) when the pointer is actively over THAT trigger,
 * keyboard focus (Tab — not mouse focus while already hovering), and click/tap
 * for InfoHint/TermHint pin. Escape, outside tap, and leaving both trigger and
 * popup close it. Action Tooltip open state is armed by pointerenter/leave on
 * the trigger itself — never parent-row :hover or CSS group-hover.
 *
 * GUARANTEES (each has a regression test in Tooltip.test.jsx)
 *  - At most one popup is open anywhere on the page.
 *  - A popup never outlives its pointer: if pointerleave is missed (trigger
 *    re-rendered, covered by a modal, scrolled away) the first pointermove
 *    outside trigger and popup closes it. Window blur, tab hide, the pointer
 *    leaving the page, and a trigger that is detached or zero-size close it too.
 *  - Touch never opens hover tooltips; hints pin on tap.
 *  - Mouse focus never opens a popup; keyboard focus always does (no one-shot
 *    "suppress" flags that can swallow a later real focus).
 *  - An unmounted trigger can't leave its ActionTooltipGroup warm.
 *  - Popups sit above every modal, lightbox, and menu.
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
import { ICON_SIZE } from "../../lib/ui-tokens";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "../../lib/utils";
import { haptic } from "../../utils/haptics.js";

/** Above ModalCard (z-50/90), PhotoLightbox (z-80), Dropdown (z-100), Navbar menu (z-2000). */
const POPUP_Z = "z-[3000]";

/** @type {import("react").Context<null | {
 *   delayMs: number,
 *   leaveGraceMs: number,
 *   activeId: string | null,
 *   isWarm: () => boolean,
 *   requestOpen: (id: string) => void,
 *   requestClose: (id: string) => void,
 * }>} */
const TooltipGroupContext = createContext(null);

// ── Input modality ──────────────────────────────────────────────────────────
// Same idea as :focus-visible, but tracked ourselves so it also works for
// programmatic focus (modal closes → focus restored). Keyboard focus shows a
// popup; focus that came from a mouse or finger never does.
let keyboardModality = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (keyboardModality = true), true);
  document.addEventListener("pointerdown", () => (keyboardModality = false), true);
}

// ── One popup at a time ─────────────────────────────────────────────────────
/** @type {null | { id: string, close: () => void }} */
let openEntry = null;

/** @param {string} id @param {() => void} close */
function claimOpen(id, close) {
  const prev = openEntry;
  openEntry = { id, close };
  if (prev && prev.id !== id) prev.close();
}

/** @param {string} id */
function releaseOpen(id) {
  if (openEntry?.id === id) openEntry = null;
}

/**
 * Registers an open popup as THE open popup; any other one is closed.
 * @param {boolean} open
 * @param {string} id
 * @param {() => void} close
 */
function useExclusiveOpen(open, id, close) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return undefined;
    claimOpen(id, () => closeRef.current());
    return () => releaseOpen(id);
  }, [open, id]);
}

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
 * Keeps a fixed popup next to its trigger. One reposition per frame while
 * scrolling, and none when the spot is unchanged. If the trigger is gone or
 * collapsed (display:none, removed) the popup is dismissed instead of floating.
 *
 * @param {{
 *   open: boolean,
 *   triggerRef: import("react").RefObject<HTMLElement | null>,
 *   popupRef: import("react").RefObject<HTMLElement | null>,
 *   content: import("react").ReactNode,
 *   onLost: () => void,
 * }} args
 */
function usePopupPosition({ open, triggerRef, popupRef, content, onLost }) {
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const onLostRef = useRef(onLost);
  useEffect(() => {
    onLostRef.current = onLost;
  });

  const update = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const hidden = typeof trigger.checkVisibility === "function" && !trigger.checkVisibility();
    if (!trigger.isConnected || hidden) {
      onLostRef.current();
      return;
    }
    const next = placePopup(trigger, popup);
    setPosition((prev) => (prev.top === next.top && prev.left === next.left ? prev : next));
  }, [triggerRef, popupRef]);

  useLayoutEffect(() => {
    if (open) update();
  }, [open, update, content]);

  useEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [open, update]);

  return position;
}

/**
 * Document-level safety nets while a popup is open. These don't rely on the
 * trigger's own pointerleave, which browsers skip when the element re-renders,
 * gets covered, or is removed under the cursor.
 *
 *  - pointermove outside trigger+popup → onStray (consumer resets its state)
 *  - pointerdown outside               → onDismiss
 *  - window blur / tab hidden / pointer left the page → onDismiss
 *
 * @param {{
 *   open: boolean,
 *   watchPointer: boolean,
 *   triggerRef: import("react").RefObject<HTMLElement | null>,
 *   popupRef: import("react").RefObject<HTMLElement | null>,
 *   onStray: () => void,
 *   onDismiss: () => void,
 * }} args
 */
function useOpenGuards({ open, watchPointer, triggerRef, popupRef, onStray, onDismiss }) {
  const strayRef = useRef(onStray);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    strayRef.current = onStray;
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return undefined;
    const inside = (t) => !!(t instanceof Node && (triggerRef.current?.contains(t) || popupRef.current?.contains(t)));
    const onMove = (event) => {
      if (watchPointer && !inside(event.target)) strayRef.current();
    };
    const onDown = (event) => {
      if (!inside(event.target)) dismissRef.current();
    };
    const onHide = () => dismissRef.current();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") dismissRef.current();
    };
    const onPageLeave = (event) => {
      if (!event.relatedTarget) dismissRef.current();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("visibilitychange", onVisibility);
    document.documentElement.addEventListener("pointerleave", onHide);
    document.addEventListener("mouseout", onPageLeave);
    window.addEventListener("blur", onHide);
    return () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("visibilitychange", onVisibility);
      document.documentElement.removeEventListener("pointerleave", onHide);
      document.removeEventListener("mouseout", onPageLeave);
      window.removeEventListener("blur", onHide);
    };
  }, [open, watchPointer, triggerRef, popupRef]);
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
 *     onPointerEnter: (e: import("react").PointerEvent) => void,
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
  const textClass = surface === "primary" ? "text-secondary" : "text-primary";

  // True only while WE move focus (Escape returns it to the trigger).
  // Focus events are synchronous, so this can never outlive the call.
  const restoringFocusRef = useRef(false);

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

  const position = usePopupPosition({ open, triggerRef, popupRef, content, onLost: hide });
  useExclusiveOpen(open, tooltipId, hide);

  // Hover-opened popups close when the pointer is anywhere else, even if
  // pointerleave never fired. Pinned and keyboard-focused ones stay put.
  useOpenGuards({
    open,
    watchPointer: open && !pinned,
    triggerRef,
    popupRef,
    onStray: () => {
      if (keyboardModality && document.activeElement === triggerRef.current) return;
      if (!closeTimer.current) scheduleHide();
    },
    onDismiss: hide,
  });

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === "Escape") {
        hide();
        restoringFocusRef.current = true;
        triggerRef.current?.focus();
        restoringFocusRef.current = false;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, hide]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const onPointerEnter = (event) => {
    if (event?.pointerType === "touch") return; // taps pin via onClick
    scheduleShow();
  };

  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    haptic("light");
    if (open && pinned) hide();
    else {
      clearTimers();
      setPinned(true);
      setOpen(true);
    }
  };

  const onFocus = () => {
    if (restoringFocusRef.current || !keyboardModality) return;
    show();
  };

  const onBlur = (event) => {
    const next = event.relatedTarget;
    if (popupRef.current?.contains(next) || triggerRef.current?.contains(next)) return;
    // A pinned popup survives mouse blur (the user may be reading or selecting
    // inside it) but not Tabbing away.
    if (!pinned || keyboardModality) hide();
  };

  return (
    <span className={cn("relative inline-flex items-baseline", className)} data-slot={dataSlot}>
      {renderTrigger({
        triggerRef,
        open,
        tooltipId,
        onClick,
        onPointerEnter,
        onPointerLeave: pinned ? undefined : scheduleHide,
        onFocus,
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
              POPUP_Z,
              "surface-secondary ring-2 ring-inset ring-accent",
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
            "hover:bg-current/15 motion-safe:transition-colors motion-safe:duration-150",
            textClass,
          )}
        >
          <Info size={ICON_SIZE.sm} aria-hidden="true" />
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
  // Mirrors activeId synchronously so side effects never run inside a state
  // updater (StrictMode runs those twice) and isWarm() is never a render behind.
  const activeRef = useRef(/** @type {string | null} */ (null));
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
      activeRef.current = id;
      setActiveId(id);
    },
    [clearGrace],
  );

  const requestClose = useCallback(
    (id) => {
      if (activeRef.current !== id) return;
      activeRef.current = null;
      setActiveId(null);
      clearGrace();
      graceTimer.current = setTimeout(() => {
        warmRef.current = false;
        graceTimer.current = null;
      }, leaveGraceMs);
    },
    [clearGrace, leaveGraceMs],
  );

  const isWarm = useCallback(() => warmRef.current || activeRef.current != null, []);

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
 * Hover open/close is driven only by pointerenter/pointerleave on THIS
 * trigger (active hover on the given button) — never parent-row :hover or
 * CSS group-hover. Delayed opens re-check that the pointer is still inside.
 *
 * Until the first hover or keyboard focus the trigger is a bare span: lists
 * mount hundreds of these, and the popup's timers, guards and listeners
 * (TooltipController) only mount once someone actually reaches for one.
 *
 * @param {{
 *   content: import("react").ReactNode,
 *   children: import("react").ReactNode,
 *   surface?: "primary"|"secondary",
 *   delayMs?: number,
 *   className?: string,
 *   popupClassName?: string,
 * }} props
 */
export function Tooltip({ content, children, surface: _surface = "secondary", delayMs, className = "", popupClassName = "" }) {
  const triggerRef = useRef(/** @type {HTMLElement | null} */ (null));
  /** @type {import("react").MutableRefObject<null | TooltipHandlers>} */
  const handlersRef = useRef(null);
  // What woke the controller, replayed once it mounts. Cleared when the
  // pointer leaves (or focus goes) before that.
  const wakeRef = useRef(/** @type {null | "pointer" | "focus"} */ (null));
  const [live, setLive] = useState(false);

  return (
    <span
      ref={triggerRef}
      className={cn("relative inline-flex", className)}
      data-slot="tooltip"
      onPointerEnter={(event) => {
        // Touch "hover" is just the start of a tap; the control's own click runs.
        if (event.pointerType === "touch") return;
        if (handlersRef.current) handlersRef.current.pointerEnter();
        else {
          wakeRef.current = "pointer";
          setLive(true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        if (handlersRef.current) handlersRef.current.pointerLeave();
        else if (wakeRef.current === "pointer") wakeRef.current = null;
      }}
      onFocusCapture={() => {
        if (handlersRef.current) {
          handlersRef.current.focus();
          return;
        }
        // Mouse or finger focus never opens a popup; hover and click own it.
        if (wakeRef.current === "pointer" || !keyboardModality) return;
        wakeRef.current = "focus";
        setLive(true);
      }}
      onBlurCapture={(event) => {
        if (handlersRef.current) handlersRef.current.blur(event);
        else if (wakeRef.current === "focus") wakeRef.current = null;
      }}
      onClick={() => handlersRef.current?.click()}
    >
      {children}
      {live ? (
        <TooltipController
          content={content}
          delayMs={delayMs}
          popupClassName={popupClassName}
          triggerRef={triggerRef}
          handlersRef={handlersRef}
          wakeRef={wakeRef}
        />
      ) : null}
    </span>
  );
}

/**
 * One tooltip for a group of controls, instead of a Tooltip around each.
 * Every descendant with a `data-tooltip` attribute gets that text as its
 * label, with the same rules as Tooltip: hover after a short delay (then
 * siblings at once), keyboard focus, never mouse focus, dismissed on click
 * and Escape. Nothing but this element's listeners mounts until someone
 * reaches for a control, so long lists can give every row its icon buttons.
 * Pair each control with an aria-label; the tooltip is only the visible label.
 *
 * @param {{
 *   children: import("react").ReactNode,
 *   delayMs?: number,
 *   className?: string,
 *   popupClassName?: string,
 *   ref?: import("react").Ref<HTMLDivElement>,
 *   [key: string]: any,
 * }} props
 */
export function TooltipTargets({
  children,
  delayMs = 400,
  className = "",
  popupClassName = "",
  ref = undefined,
  onClick = undefined,
  ...rest
}) {
  const hostRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  /** @param {HTMLDivElement | null} node */
  const setHost = (node) => {
    hostRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  const triggerRef = useRef(/** @type {HTMLElement | null} */ (null));
  /** @type {import("react").MutableRefObject<null | TooltipHandlers>} */
  const handlersRef = useRef(null);
  const wakeRef = useRef(/** @type {null | "pointer" | "focus"} */ (null));
  // The control the tooltip belongs to; a new one remounts the controller.
  const [target, setTarget] = useState(/** @type {null | { n: number, content: string }} */ (null));
  const seq = useRef(0);
  const pointerInside = useRef(false);

  /** @param {EventTarget | null} node */
  const controlOf = (node) => {
    const el = node instanceof Element ? node.closest("[data-tooltip]") : null;
    return el instanceof HTMLElement && hostRef.current?.contains(el) ? el : null;
  };
  /** @param {HTMLElement} el @param {"pointer" | "focus"} how */
  const wake = (el, how) => {
    triggerRef.current = el;
    // A Tab onto another control while the pointer rests elsewhere: the
    // pointer is not on this one until it says so.
    pointerInside.current = how === "pointer";
    wakeRef.current = how;
    seq.current += 1;
    setTarget({ n: seq.current, content: el.getAttribute("data-tooltip") || "" });
  };

  return (
    <div
      {...rest}
      ref={setHost}
      className={className}
      onPointerOver={(event) => {
        // Touch "hover" is just the start of a tap; the control's own click runs.
        if (event.pointerType === "touch") return;
        const el = controlOf(event.target);
        if (!el) return;
        if (el === triggerRef.current) {
          // Moving between the control's own children is not a new hover.
          if (pointerInside.current) return;
          pointerInside.current = true;
          if (handlersRef.current) handlersRef.current.pointerEnter();
          else wakeRef.current = "pointer";
          return;
        }
        handlersRef.current?.pointerLeave();
        wake(el, "pointer");
      }}
      onPointerOut={(event) => {
        if (event.pointerType === "touch") return;
        const el = controlOf(event.target);
        if (!el || el !== triggerRef.current) return;
        if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return;
        pointerInside.current = false;
        if (handlersRef.current) handlersRef.current.pointerLeave();
        else if (wakeRef.current === "pointer") wakeRef.current = null;
      }}
      onFocus={(event) => {
        const el = controlOf(event.target);
        if (!el) return;
        if (el === triggerRef.current && handlersRef.current) {
          handlersRef.current.focus();
          return;
        }
        // Mouse or finger focus never opens a popup; hover and click own it.
        if (!keyboardModality) return;
        wake(el, "focus");
      }}
      onBlur={(event) => {
        const el = controlOf(event.target);
        if (!el || el !== triggerRef.current) return;
        if (handlersRef.current) handlersRef.current.blur(event);
        else if (wakeRef.current === "focus") wakeRef.current = null;
      }}
      onClick={(event) => {
        if (controlOf(event.target) === triggerRef.current) handlersRef.current?.click();
        onClick?.(event);
      }}
    >
      {children}
      {target ? (
        // The provider outlives each controller, so moving to a sibling
        // opens its label at once, as in an ActionTooltipGroup.
        <TooltipProvider delayMs={delayMs}>
          <TooltipController
            key={target.n}
            content={target.content}
            popupClassName={popupClassName}
            triggerRef={triggerRef}
            handlersRef={handlersRef}
            wakeRef={wakeRef}
          />
        </TooltipProvider>
      ) : null}
    </div>
  );
}

TooltipTargets.propTypes = {
  children: PropTypes.node,
  ref: PropTypes.oneOfType([PropTypes.func, PropTypes.shape({ current: PropTypes.any })]),
  onClick: PropTypes.func,
  delayMs: PropTypes.number,
  className: PropTypes.string,
  popupClassName: PropTypes.string,
};

/**
 * @typedef {{
 *   pointerEnter: () => void,
 *   pointerLeave: () => void,
 *   focus: () => void,
 *   blur: (event: import("react").FocusEvent) => void,
 *   click: () => void,
 * }} TooltipHandlers
 */

/**
 * The live half of Tooltip: open state, timers, the popup and its guards.
 * Renders only the portaled popup; the trigger span stays in Tooltip.
 *
 * @param {{
 *   content: import("react").ReactNode,
 *   delayMs?: number,
 *   popupClassName: string,
 *   triggerRef: import("react").RefObject<HTMLElement | null>,
 *   handlersRef: import("react").MutableRefObject<null | TooltipHandlers>,
 *   wakeRef: import("react").MutableRefObject<null | "pointer" | "focus">,
 * }} props
 */
function TooltipController({ content, delayMs, popupClassName, triggerRef, handlersRef, wakeRef }) {
  const group = useContext(TooltipGroupContext);
  const localId = useId();
  const tooltipId = useId();
  const popupRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const openTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const closeTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const [soloOpen, setSoloOpen] = useState(false);

  // Active hover on this trigger — set only by pointerenter/leave on the
  // trigger element itself (not the file row, not a CSS :hover ancestor).
  const pointerInsideRef = useRef(false);
  // Pointer over the portaled label (optional bridge during the leave grace).
  const popupInsideRef = useRef(false);
  // Keyboard focus (Tab) — mouse focus is ignored via input modality.
  const keyboardFocusRef = useRef(false);

  const open = group ? group.activeId === localId : soloOpen;
  const resolvedDelay = delayMs ?? group?.delayMs ?? 400;

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const isActivelyArmed = useCallback(
    () => pointerInsideRef.current || popupInsideRef.current || keyboardFocusRef.current,
    [],
  );

  const showNow = useCallback(() => {
    // Never open from a stale timer after the pointer has already left.
    if (!isActivelyArmed()) return;
    clearTimers();
    if (group) group.requestOpen(localId);
    else setSoloOpen(true);
  }, [clearTimers, group, isActivelyArmed, localId]);

  const hideNow = useCallback(() => {
    clearTimers();
    keyboardFocusRef.current = false;
    popupInsideRef.current = false;
    if (group) group.requestClose(localId);
    else setSoloOpen(false);
  }, [clearTimers, group, localId]);

  const scheduleShow = useCallback(() => {
    clearTimers();
    if (!isActivelyArmed()) return;
    const warm = group ? group.isWarm() : false;
    const wait = warm ? 0 : resolvedDelay;
    if (wait <= 0) {
      showNow();
      return;
    }
    openTimer.current = setTimeout(() => {
      // Re-check active hover/focus — the delay may have outlived the pointer.
      if (!isActivelyArmed()) return;
      showNow();
    }, wait);
  }, [clearTimers, group, isActivelyArmed, resolvedDelay, showNow]);

  const scheduleHide = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => {
      // Pointer may have returned (or keyboard focus remains) during the grace.
      if (isActivelyArmed()) return;
      hideNow();
    }, 120);
  }, [clearTimers, hideNow, isActivelyArmed]);

  const position = usePopupPosition({ open, triggerRef, popupRef, content, onLost: hideNow });
  useExclusiveOpen(open, tooltipId, hideNow);

  // pointerleave can be skipped (re-render, modal opens over the button, the
  // button is removed or disabled under the cursor). The first pointermove
  // anywhere else proves the pointer is gone: drop the stale flags and close.
  useOpenGuards({
    open,
    watchPointer: open,
    triggerRef,
    popupRef,
    onStray: () => {
      pointerInsideRef.current = false;
      popupInsideRef.current = false;
      if (!closeTimer.current) scheduleHide();
    },
    onDismiss: hideNow,
  });

  useEffect(() => {
    if (!open) return undefined;
    function onKey(event) {
      if (event.key === "Escape") hideNow();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, hideNow]);

  // Unmounting while open (or pending) must release the group, otherwise
  // activeId stays set and every sibling opens with no delay forever.
  const groupRef = useRef(group);
  useEffect(() => {
    groupRef.current = group;
  });
  useEffect(
    () => () => {
      clearTimers();
      groupRef.current?.requestClose(localId);
    },
    [clearTimers, localId],
  );

  // The trigger span forwards its events here; always the latest closures.
  const ownHandlers = useRef(/** @type {null | TooltipHandlers} */ (null));
  useLayoutEffect(() => {
    handlersRef.current = ownHandlers.current = {
      pointerEnter: () => {
        pointerInsideRef.current = true;
        scheduleShow();
      },
      pointerLeave: () => {
        pointerInsideRef.current = false;
        scheduleHide();
      },
      focus: () => {
        // Mouse focus (pointer inside) or finger/click focus: hover and click own it.
        if (pointerInsideRef.current || !keyboardModality) return;
        keyboardFocusRef.current = true;
        showNow();
      },
      blur: (event) => {
        const next = event.relatedTarget;
        if (triggerRef.current?.contains(next) || popupRef.current?.contains(next)) return;
        keyboardFocusRef.current = false;
        // Stay armed while the pointer is still on this button.
        if (pointerInsideRef.current) return;
        hideNow();
      },
      click: () => {
        // Dismiss on activate. If the pointer is still on this button, active
        // hover remains the source of truth — re-arm after hide so we do not
        // stay stuck closed until an artificial leave/enter. Opening a modal
        // typically covers the trigger and fires pointerleave, which cancels
        // the pending reopen via isActivelyArmed().
        hideNow();
        if (pointerInsideRef.current) scheduleShow();
      },
    };
  });
  // Only clear our own: under TooltipTargets the next trigger's controller
  // mounts (and sets its handlers) before this cleanup runs.
  useEffect(() => () => {
    if (handlersRef.current === ownHandlers.current) handlersRef.current = null;
  }, [handlersRef]);

  // Replay what woke this controller (the hover or keyboard focus that the
  // bare trigger saw before it mounted), unless it already ended.
  useEffect(() => {
    const wake = wakeRef.current;
    wakeRef.current = null;
    if (wake === "pointer") handlersRef.current?.pointerEnter();
    else if (wake === "focus") handlersRef.current?.focus();
  }, [handlersRef, wakeRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={popupRef}
      id={tooltipId}
      role="tooltip"
      data-slot="tooltip-popup"
      onPointerEnter={() => {
        popupInsideRef.current = true;
        showNow();
      }}
      onPointerLeave={() => {
        popupInsideRef.current = false;
        scheduleHide();
      }}
      style={{ position: "fixed", top: position.top, left: position.left }}
      className={cn(
        POPUP_Z,
        "surface-secondary ring-2 ring-inset ring-accent",
        "max-w-xs rounded-large-element px-3 py-1.5 text-xs leading-snug pointer-events-auto",
        "motion-safe:transition-opacity motion-safe:duration-150",
        popupClassName,
      )}
    >
      {content}
    </div>,
    document.body,
  );
}

Tooltip.propTypes = {
  content: PropTypes.node.isRequired,
  children: PropTypes.node.isRequired,
  surface: PropTypes.oneOf(["primary", "secondary"]),
  delayMs: PropTypes.number,
  className: PropTypes.string,
  popupClassName: PropTypes.string,
};

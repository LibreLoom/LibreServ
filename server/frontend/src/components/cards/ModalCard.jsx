/* eslint-disable react-refresh/only-export-components -- useModalClose is the paired hook for ModalCard */
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import Card from "./Card";
import { useAnimatedHeight } from "../../hooks/useAnimatedHeight";
import { haptic } from "../../utils/haptics";

/** @type {import('react').Context<(() => void) | null>} */
const ModalCloseContext = createContext(null);

/** Animated close — waits for exit transition before calling onClose. */
export function useModalClose() {
  const close = useContext(ModalCloseContext);
  if (!close) {
    throw new Error("useModalClose must be used within ModalCard");
  }
  return close;
}

/** Longest modal exit animation (overlay + card pop-out). */
export const EXIT_ANIMATION_MS = 300;

/** Card `.pop-in` duration in `index.css` (fallback if `animationend` is skipped). */
export const POP_IN_ANIMATION_MS = 300;

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @typedef {object} ModalCardProps
 * @property {import('react').ReactNode} [title]
 * @property {import('react').ReactNode|function({close: () => void}): import('react').ReactNode} [children]
 * @property {() => void} [onClose]
 * @property {boolean} [open] Controlled visibility. When set to false, plays the exit
 *   animation then unmounts. Prefer `<ModalCard open={!!x} onClose={() => setX(null)}>`
 *   over `{x && <ModalCard>}` so parents that clear state still get animate-out.
 *   Defaults to true when omitted (legacy always-mounted / conditionally rendered usage).
 * @property {boolean} [showCloseButton]
 * @property {string} [size]
 * @property {boolean} [mobileFullscreen]
 * @property {import('react').ReactNode | function({ close: () => void }): import('react').ReactNode} [footer]
 * @property {string} [className]
 * @property {import('react').RefObject} [initialFocusRef]
 * @property {boolean} [loading] Show a skeleton body until content is ready.
 */

/** @param {ModalCardProps} props */
export default function ModalCard({
  title,
  children,
  onClose,
  open = true,
  showCloseButton = true,
  size = "md",
  mobileFullscreen = false,
  footer,
  className = "",
  initialFocusRef,
  loading = false,
}) {
  const [isClosing, setIsClosing] = useState(false);
  const [present, setPresent] = useState(open);
  const [scrollReady, setScrollReady] = useState(() => prefersReducedMotion());
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  // Rebind when the portal remounts after exit — a mount-only observer would
  // miss the second open and leave height:auto (content jumps instead of easing).
  const { outerRef, innerRef } = useAnimatedHeight(present);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const isClosingRef = useRef(false);
  const exitTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const setRefs = useCallback((node) => {
    dialogRef.current = node;
    outerRef.current = node;
  }, [outerRef]);

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current != null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const finishExit = useCallback((notify) => {
    clearExitTimer();
    setPresent(false);
    setIsClosing(false);
    isClosingRef.current = false;
    if (notify) onCloseRef.current?.();
  }, [clearExitTimer]);

  /** @param {boolean} notify Whether to call onClose after the exit animation. */
  const beginExit = useCallback((notify) => {
    if (isClosingRef.current) return;
    haptic("light");
    isClosingRef.current = true;
    setIsClosing(true);
    setScrollReady(false);
    exitTimerRef.current = setTimeout(() => {
      finishExit(notify);
    }, EXIT_ANIMATION_MS);
  }, [finishExit]);

  const handleClose = useCallback(() => {
    beginExit(true);
  }, [beginExit]);

  useEffect(() => {
    if (open) {
      clearExitTimer();
      isClosingRef.current = false;
      setIsClosing(false);
      setScrollReady(prefersReducedMotion());
      setPresent(true);
      return;
    }
    if (present && !isClosingRef.current) {
      beginExit(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => clearExitTimer(), [clearExitTimer]);

  useEffect(() => {
    if (!present || scrollReady || isClosing) return undefined;
    if (prefersReducedMotion()) {
      setScrollReady(true);
      return undefined;
    }
    const id = window.setTimeout(() => setScrollReady(true), POP_IN_ANIMATION_MS);
    return () => window.clearTimeout(id);
  }, [present, scrollReady, isClosing]);

  const handlePopInEnd = useCallback((event) => {
    const name = String(event.animationName || event.nativeEvent?.animationName || "");
    if (name.includes("pop-out")) return;
    if (name && !name.includes("pop-in")) return;
    setScrollReady(true);
  }, []);

  const content = loading
    ? null
    : typeof children === "function"
      ? children({ close: handleClose })
      : children;

  useEffect(() => {
    if (!present) return undefined;

    previousFocusRef.current = document.activeElement;
    document.body.style.overflow = "hidden";
    if (initialFocusRef?.current) {
      initialFocusRef.current.focus();
    } else {
      closeButtonRef.current?.focus();
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }

      if (event.key === "Tab") {
        const focusableElements = dialogRef.current?.querySelectorAll(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusableElements || focusableElements.length === 0) return;
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  if (!present) return null;

  const widthClasses =
    size === "fullscreen"
      ? "max-w-[95vw]"
      : size === "lg"
        ? "sm:max-w-3xl"
        : size === "xl"
          ? "sm:max-w-5xl"
          : "sm:max-w-md";

  const maxHeightClasses =
    size === "fullscreen"
      ? "max-h-[95vh]"
      : mobileFullscreen
        ? "max-h-[100dvh] sm:max-h-[calc(95vh-4rem)]"
        : "max-h-full sm:max-h-[calc(95vh-4rem)]";

  const mobileFsClasses = mobileFullscreen
    ? "p-0 sm:p-4 [&>div>div>div]:rounded-none sm:[&>div>div>div]:rounded-large-element"
    : "p-4";

  return createPortal(
    <div
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 bg-primary/60 backdrop-blur-sm flex items-center justify-center z-50",
        mobileFsClasses,
        isClosing ? "animate-out fade-out zoom-out-95" : "animate-in fade-in zoom-in-95"
      )}
      onClick={handleClose}
    >
      <div
        ref={setRefs}
        data-slot="dialog-content"
        role="dialog"
        aria-modal="true"
        aria-busy={loading || undefined}
        aria-labelledby={titleId}
        className={cn(
          "w-full overflow-hidden rounded-large-element bg-secondary text-primary",
          "transition-[height,max-width,max-height,width] ease-[var(--motion-easing-emphasized-decelerate)] motion-reduce:transition-none",
          widthClasses,
          maxHeightClasses
        )}
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
        onClick={(event) => event.stopPropagation()}
      >
        {/*
          Scroller carries viewport max-height + overflow. Measure target is a
          child without max-height so ResizeObserver sees content grow (loading
          → form) and the outer height transition can run. Measuring the
          max-h-full scroller itself locked the first height forever.
        */}
        <div
          data-slot="dialog-scroller"
          className={cn(
            "h-full max-h-full overscroll-contain",
            scrollReady && !isClosing ? "overflow-y-auto" : "overflow-hidden",
          )}
          onAnimationEnd={handlePopInEnd}
        >
          <div ref={innerRef} data-slot="dialog-measure">
            <ModalCloseContext.Provider value={handleClose}>
              <Card
                noHeightAnim
                noPopIn
                className={cn("relative overflow-hidden", className, isClosing ? "pop-out" : "pop-in")}
              >
                {showCloseButton && (
                  <button
                    type="button"
                    data-slot="dialog-close"
                    onClick={handleClose}
                    className={cn(
                      "absolute top-5 right-5 p-2 rounded-pill text-primary cursor-pointer",
                      "motion-safe:transition-all hover:bg-primary hover:text-secondary",
                      "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2",
                      "focus-visible:ring-offset-secondary no-focus-outline"
                    )}
                    aria-label="Close"
                    ref={closeButtonRef}
                  >
                    <X size={20} aria-hidden="true" />
                  </button>
                )}

                {title && (
                  <h2 id={titleId} className="text-xl font-mono font-normal mb-4 pr-10">
                    {title}
                  </h2>
                )}

                {loading ? (
                  <div className="p-5 space-y-4" aria-hidden="true">
                    <div className="h-4 w-3/4 rounded-pill bg-accent/30 animate-pulse" />
                    <div className="h-4 w-full rounded-pill bg-accent/30 animate-pulse" />
                    <div className="h-4 w-2/3 rounded-pill bg-accent/30 animate-pulse" />
                    <div className="h-10 w-full rounded-pill bg-accent/30 animate-pulse" />
                    <div className="flex gap-3 pt-2">
                      <div className="h-10 flex-1 rounded-pill bg-accent/30 animate-pulse" />
                      <div className="h-10 flex-1 rounded-pill bg-accent/30 animate-pulse" />
                    </div>
                  </div>
                ) : (
                  content
                )}

                {footer && (
                  <div className="mt-4">
                    {typeof footer === "function" ? footer({ close: handleClose }) : footer}
                  </div>
                )}
              </Card>
            </ModalCloseContext.Provider>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

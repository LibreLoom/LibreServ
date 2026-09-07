import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import Card from "./Card";

/** Card `p-5` on each side — content must fit inside the padded area. */
const CARD_PAD_X = 40;
/** `gap-3` between title / side chrome in the combined row. */
const ROW_GAP = 12;
/** Extra room required before collapsing a split back to one pill (anti-flicker). */
const UNSPLIT_SLACK = 24;

/**
 * HeaderCard — the page title surface with automatic fit-or-split.
 *
 * Tries a single one-line pill first. When left/right chrome cannot fit beside
 * the title without overflowing, splits into stacked cards (title, then left,
 * then right) — the LibreServ behavior introduced in 4b1df5b0 / e921d81a and
 * removed by a3228d23's "always one line" rewrite.
 *
 * - Do NOT put navigation here. Use the bottom Navbar.
 * - Do NOT put multi-line taglines here. Put them in Page `bottomContent`.
 * - Optional `leftContent` / `rightContent` are same-row chrome when they fit.
 *
 * @typedef {object} HeaderCardProps
 * @property {any} title
 * @property {string} [id]
 * @property {string} [className]
 * @property {string} [titleClassName]
 * @property {import('react').ReactNode} [leftContent]
 * @property {import('react').ReactNode} [rightContent]
 * @property {string} [rightContentClassName]
 * @property {boolean} [dynamicRounding]
 * @property {import('react').ReactNode} [children]
 */

/** @param {HeaderCardProps} props */
export default function HeaderCard({
  title,
  id,
  className = "",
  titleClassName = "",
  leftContent,
  rightContent,
  rightContentClassName = "",
  dynamicRounding = true,
  children,
}) {
  const hasLeft = Boolean(leftContent);
  const hasRight = Boolean(rightContent) || Boolean(children);
  const hasSides = hasLeft || hasRight;

  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const probeRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const titleRef = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  const [split, setSplit] = useState(false);
  const [isMultiline, setIsMultiline] = useState(false);

  const remeasure = useCallback(() => {
    const container = containerRef.current;
    const probe = probeRef.current;
    if (!container || !probe || !hasSides) {
      setSplit(false);
      return;
    }

    const available = container.clientWidth - CARD_PAD_X;
    if (available <= 0) return;

    const needed = probe.scrollWidth;
    setSplit((wasSplit) => {
      if (wasSplit) {
        // Only reunite when there is clear spare room.
        return needed + UNSPLIT_SLACK > available;
      }
      return needed > available;
    });

    const titleEl = titleRef.current;
    if (titleEl && titleEl.offsetHeight > 0) {
      const style = window.getComputedStyle(titleEl);
      const lineHeight = parseFloat(style.lineHeight) || titleEl.offsetHeight;
      setIsMultiline(titleEl.offsetHeight > lineHeight * 1.4);
    }
  }, [hasSides]);

  useEffect(() => {
    if (!hasSides) {
      setSplit(false);
      return;
    }

    const container = containerRef.current;
    const probe = probeRef.current;
    if (!container) return;

    const timeoutId = window.setTimeout(remeasure, 50);
    /** @type {ResizeObserver | null} */
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(remeasure);
      observer.observe(container);
      if (probe) observer.observe(probe);
    }
    window.addEventListener("resize", remeasure);

    return () => {
      window.clearTimeout(timeoutId);
      observer?.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [hasSides, split, remeasure, title, leftContent, rightContent, children]);

  const titleClasses = cn(
    "font-mono text-2xl font-normal tracking-tight text-center min-w-0",
    !split && "truncate",
    titleClassName,
  );

  const baseCardClass = "border border-primary/30 transition-all duration-300 ease-in-out";
  const titleCardClass = cn(
    baseCardClass,
    dynamicRounding && !isMultiline && "rounded-pill",
    className,
  );

  const probe = hasSides ? (
    <div
      className="pointer-events-none absolute h-0 overflow-hidden opacity-0"
      aria-hidden="true"
    >
      <div
        ref={probeRef}
        className="flex w-max items-center whitespace-nowrap"
        style={{ gap: ROW_GAP }}
      >
        {hasLeft ? <div className="shrink-0">{leftContent}</div> : null}
        <div className="font-mono text-2xl font-normal tracking-tight shrink-0">
          {title}
        </div>
        {hasRight ? (
          <div className={cn("shrink-0 flex items-center gap-3", rightContentClassName)}>
            {rightContent}
            {children}
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  if (hasSides && split) {
    return (
      <div ref={containerRef} className="relative flex flex-col gap-3" data-slot="header-card-split">
        {probe}
        <Card className={titleCardClass}>
          <div className="flex items-center justify-center min-h-10">
            <h1 ref={titleRef} id={id} className={titleClasses}>
              {title}
            </h1>
          </div>
        </Card>
        {hasLeft ? (
          <Card className={baseCardClass}>
            <div className="flex items-center justify-center text-center min-h-10">
              {leftContent}
            </div>
          </Card>
        ) : null}
        {hasRight ? (
          <Card className={baseCardClass}>
            <div
              className={cn(
                "flex items-center justify-center gap-3 text-center min-h-10",
                rightContentClassName,
              )}
            >
              {rightContent}
              {children}
            </div>
          </Card>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full" data-slot="header-card-combined">
      {probe}
      <Card className={titleCardClass}>
        <div
          className={cn(
            "flex items-center gap-3 min-h-10",
            hasSides && "grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,auto)]",
            !hasSides && "justify-center",
          )}
        >
          {hasSides ? (
            <>
              <div className="flex items-center justify-start min-w-0">
                {hasLeft ? leftContent : <span aria-hidden="true" />}
              </div>
              <h1 ref={titleRef} id={id} className={titleClasses}>
                {title}
              </h1>
              <div
                className={cn(
                  "flex items-center justify-end gap-3 min-w-0",
                  rightContentClassName,
                )}
              >
                {rightContent}
                {children}
              </div>
            </>
          ) : (
            <h1 ref={titleRef} id={id} className={titleClasses}>
              {title}
            </h1>
          )}
        </div>
      </Card>
    </div>
  );
}

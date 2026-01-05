import { useCallback, useEffect, useState } from "react";
import Card from "./Card";

/* ======================================================================
   Alignment utilities
   ====================================================================== */

const alignmentClasses = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/* ======================================================================
   HeaderCard
   A responsive, accessible page header container.
   Guarantees a single semantic heading for screen readers.
   ====================================================================== */

export default function HeaderCard({
  title,
  id,
  align = "center",
  className = "",
  titleClassName = "",
  leftContent,
  rightContent,
  rightContentClassName = "",
  bottomContent,
  bottomContentClassName = "",
  dynamicRounding = true,
  children,
}) {
  /* ------------------------------------------------------------------
     Multiline detection for rounded-pill styling
     Stores refs to both mobile and desktop titles, measures whichever is visible
     ------------------------------------------------------------------ */

  const [isMultiline, setIsMultiline] = useState(false);
  const [titleElements, setTitleElements] = useState([]);

  const addTitleRef = useCallback(
    (el) => {
      if (el && !titleElements.includes(el)) {
        setTitleElements((prev) => [...prev, el]);
      }
    },
    [titleElements],
  );

  useEffect(() => {
    if (titleElements.length === 0) return;

    const checkMultiline = () => {
      // Find the visible element (has dimensions)
      for (const el of titleElements) {
        if (el.offsetHeight > 0) {
          const style = window.getComputedStyle(el);
          const lineHeight = parseFloat(style.lineHeight);
          const actualHeight = el.offsetHeight;
          setIsMultiline(actualHeight > lineHeight * 1.4);
          return;
        }
      }
    };

    // Delay initial check to ensure layout is complete
    const timeoutId = setTimeout(checkMultiline, 50);

    const observer = new ResizeObserver(checkMultiline);
    titleElements.forEach((el) => observer.observe(el));

    window.addEventListener("resize", checkMultiline);

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
      window.removeEventListener("resize", checkMultiline);
    };
  }, [titleElements, title]);

  /* ------------------------------------------------------------------
     Content presence checks
     These determine layout structure, not rendering correctness.
     ------------------------------------------------------------------ */

  const hasBottomContent =
    bottomContent != null &&
    (typeof bottomContent !== "string" || bottomContent.trim().length > 0);

  const hasLeft = Boolean(leftContent);
  const hasRight = Boolean(rightContent) || Boolean(children);
  const hasExtras = hasLeft || hasRight || hasBottomContent;

  /* ------------------------------------------------------------------
     Alignment handling
     Desktop and mobile intentionally differ.
     ------------------------------------------------------------------ */

  const alignmentClass = alignmentClasses[align] || alignmentClasses.center;
  const responsiveAlignmentClass = alignmentClass.replace("text-", "sm:text-");

  /* ------------------------------------------------------------------
     Layout selection
     Grid only activates when side content exists.
     ------------------------------------------------------------------ */

  const needsGrid = hasLeft || hasRight;

  const contentLayout = needsGrid
    ? "flex flex-col items-center gap-3 sm:grid sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-4"
    : "flex flex-col items-center gap-2 sm:flex sm:flex-row sm:items-center sm:justify-center";

  /* ------------------------------------------------------------------
     Styling
     ------------------------------------------------------------------ */

  const baseCardClass = "border border-secondary/30";
  const titleCardClass = `${baseCardClass} ${className}`.trim();

  /* ------------------------------------------------------------------
     Title element
     ------------------------------------------------------------------ */

  const titleClasses = `font-mono text-2xl font-normal tracking-tight text-center ${responsiveAlignmentClass} ${titleClassName}`;

  /* ==================================================================
     Layout with extras (left/right/bottom content)
     ================================================================== */

  if (hasExtras) {
    return (
      <>
        {/* --------------------------------------------------------------
            Mobile layout
            Stacked cards for readability
            -------------------------------------------------------------- */}
        <div className="flex flex-col gap-3 xl:hidden">
          <Card
            className={`${titleCardClass} ${dynamicRounding && !isMultiline ? "rounded-pill" : ""}`}
          >
            <div className="flex items-center justify-center">
              <h1 ref={addTitleRef} id={id} className={titleClasses}>
                {title}
              </h1>
            </div>
          </Card>

          {hasLeft && (
            <Card className={baseCardClass}>
              <div className="flex items-center justify-center text-center">
                {leftContent}
              </div>
            </Card>
          )}

          {hasRight && (
            <Card className={baseCardClass}>
              <div
                className={`flex items-center justify-center gap-3 text-center ${rightContentClassName}`}
              >
                {rightContent && (
                  <div className="flex items-center">{rightContent}</div>
                )}
                {children}
              </div>
            </Card>
          )}

          {hasBottomContent && (
            <Card className={baseCardClass}>
              <div className={bottomContentClassName}>{bottomContent}</div>
            </Card>
          )}
        </div>

        {/* --------------------------------------------------------------
            Desktop layout
            Single cohesive header card
            -------------------------------------------------------------- */}
        <div className="hidden xl:block">
          <Card
            className={`${titleCardClass} ${dynamicRounding && !isMultiline ? "rounded-pill" : ""}`}
          >
            <div className={contentLayout}>
              {hasLeft ? (
                <div className="flex items-center justify-center text-center sm:justify-start sm:text-left">
                  {leftContent}
                </div>
              ) : hasRight ? (
                // Spacer to keep title centered when only right content exists
                <div aria-hidden="true" className="hidden sm:block" />
              ) : null}

              <h1 ref={addTitleRef} id={id} className={titleClasses}>
                {title}
              </h1>

              {hasRight && (
                <div
                  className={`flex w-full items-center justify-center gap-3 text-center sm:w-auto sm:justify-end sm:text-right ${rightContentClassName}`}
                >
                  {rightContent && (
                    <div className="flex items-center">{rightContent}</div>
                  )}
                  {children}
                </div>
              )}
            </div>

            {hasBottomContent && (
              <>
                <div
                  className="my-6 h-px w-full bg-accent/60"
                  aria-hidden="true"
                />
                <div className={`${bottomContentClassName}`}>
                  {bottomContent}
                </div>
              </>
            )}
          </Card>
        </div>
      </>
    );
  }

  /* ==================================================================
     Simple title-only header
     ================================================================== */

  return (
    <Card
      className={`${titleCardClass} ${dynamicRounding && !isMultiline ? "rounded-pill" : ""}`}
    >
      <div className={contentLayout}>
        <h1 ref={addTitleRef} id={id} className={titleClasses}>
          {title}
        </h1>
      </div>
    </Card>
  );
}

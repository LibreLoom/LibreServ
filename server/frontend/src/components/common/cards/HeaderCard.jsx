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
  children,
}) {
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
     IMPORTANT:
     - Rendered ONCE for semantics
     - Cloned visually for responsive layout
     ------------------------------------------------------------------ */

  const Title = (
    <h1
      id={id}
      className={`font-mono text-2xl font-normal tracking-tight text-center ${responsiveAlignmentClass} ${titleClassName}`}
    >
      {title}
    </h1>
  );

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
          <Card className={titleCardClass}>
            <div className="flex items-center justify-center">{Title}</div>
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
          <Card className={`${titleCardClass} rounded-pill`}>
            <div className={contentLayout}>
              {hasLeft ? (
                <div className="flex items-center justify-center text-center sm:justify-start sm:text-left">
                  {leftContent}
                </div>
              ) : hasRight ? (
                // Spacer to keep title centered when only right content exists
                <div aria-hidden="true" className="hidden sm:block" />
              ) : null}

              {Title}

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
    <Card className={titleCardClass}>
      <div className={contentLayout}>{Title}</div>
    </Card>
  );
}

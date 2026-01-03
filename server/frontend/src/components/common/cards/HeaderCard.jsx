import Card from "./Card";

const alignmentClasses = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

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
  const hasBottomContent =
    bottomContent != null &&
    (typeof bottomContent !== "string" || bottomContent.trim().length > 0);
  const alignmentClass = alignmentClasses[align] || alignmentClasses.center;
  const responsiveAlignmentClass = alignmentClass.replace("text-", "sm:text-");
  const hasLeft = Boolean(leftContent);
  const hasRight = Boolean(rightContent) || Boolean(children);
  const needsGrid = hasLeft || hasRight;
  const hasExtras = hasLeft || hasRight || hasBottomContent;
  const contentLayout = needsGrid
    ? "flex flex-col items-center gap-3 sm:grid sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-4"
    : "flex flex-col items-center gap-2 sm:flex sm:flex-row sm:items-center sm:justify-center";
  const baseCardClass = "border border-secondary/30";
  const titleCardClass = `${baseCardClass} ${className}`.trim();

  if (hasExtras) {
    return (
      <>
        <div className="flex flex-col gap-3 xl:hidden">
          <Card className={titleCardClass}>
            <div className="flex items-center justify-center">
              <h1
                id={id}
                className={`font-mono text-2xl font-normal tracking-tight text-center ${titleClassName}`}
              >
                {title}
              </h1>
            </div>
          </Card>
          {hasLeft ? (
            <Card className={baseCardClass}>
              <div className="flex items-center justify-center text-center">
                {leftContent}
              </div>
            </Card>
          ) : null}
          {hasRight ? (
            <Card className={baseCardClass}>
              <div
                className={`flex items-center justify-center gap-3 text-center ${rightContentClassName}`}
              >
                {rightContent ? (
                  <div className="flex items-center">{rightContent}</div>
                ) : null}
                {children}
              </div>
            </Card>
          ) : null}
          {hasBottomContent ? (
            <Card className={baseCardClass}>
              <div className={bottomContentClassName}>{bottomContent}</div>
            </Card>
          ) : null}
        </div>
        <div className="hidden xl:block">
          <Card className={titleCardClass}>
            <div className={contentLayout}>
              {hasLeft ? (
                <div className="flex items-center justify-center text-center sm:justify-start sm:text-left">
                  {leftContent}
                </div>
              ) : hasRight ? (
                <div aria-hidden="true" className="hidden sm:block" />
              ) : null}
              <h1
                id={id}
                className={`font-mono text-2xl font-normal tracking-tight text-center ${responsiveAlignmentClass} ${titleClassName}`}
              >
                {title}
              </h1>
              {hasRight ? (
                <div
                  className={`flex w-full items-center justify-center gap-3 text-center sm:w-auto sm:justify-end sm:text-right ${rightContentClassName}`}
                >
                  {rightContent ? (
                    <div className="flex items-center">{rightContent}</div>
                  ) : null}
                  {children}
                </div>
              ) : null}
            </div>
            {hasBottomContent ? (
              <>
                <div
                  className="mt-3 h-px w-full bg-accent/60"
                  aria-hidden="true"
                />
                <div className={`mt-3 ${bottomContentClassName}`}>
                  {bottomContent}
                </div>
              </>
            ) : null}
          </Card>
        </div>
      </>
    );
  }

  return (
    <Card className={titleCardClass}>
      <div className={contentLayout}>
        <h1
          id={id}
          className={`font-mono text-2xl font-normal tracking-tight text-center ${responsiveAlignmentClass} ${titleClassName}`}
        >
          {title}
        </h1>
      </div>
    </Card>
  );
}

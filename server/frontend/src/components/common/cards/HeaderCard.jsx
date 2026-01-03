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
  const alignmentClass = alignmentClasses[align] || alignmentClasses.center;
  const hasLeft = Boolean(leftContent);
  const hasRight = Boolean(rightContent) || Boolean(children);
  const needsGrid = hasLeft || hasRight;
  const contentLayout = needsGrid
    ? "grid grid-cols-[auto_1fr_auto] items-center gap-4"
    : "flex items-center justify-center";

  return (
    <Card className={`border border-secondary/30 ${className}`}>
      <div className={contentLayout}>
        {hasLeft ? (
          <div className="flex items-center">{leftContent}</div>
        ) : hasRight ? (
          <div aria-hidden="true" />
        ) : null}
        <h1
          id={id}
          className={`font-mono text-2xl font-normal tracking-tight ${alignmentClass} ${titleClassName}`}
        >
          {title}
        </h1>
        {hasRight ? (
          <div
            className={`flex items-center justify-end gap-3 ${rightContentClassName}`}
          >
            {rightContent ? (
              <div className="flex items-center">{rightContent}</div>
            ) : null}
            {children}
          </div>
        ) : null}
      </div>
      {bottomContent ? (
        <div className={`mt-3 ${bottomContentClassName}`}>{bottomContent}</div>
      ) : null}
    </Card>
  );
}

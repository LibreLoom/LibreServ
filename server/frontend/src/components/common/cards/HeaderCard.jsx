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
  children,
}) {
  const alignmentClass = alignmentClasses[align] || alignmentClasses.center;
  const hasActions = Boolean(children);
  const contentLayout = hasActions
    ? "grid grid-cols-[1fr_auto_1fr] items-center gap-4"
    : "flex items-center justify-center";

  return (
    <Card className={`border border-secondary/30 ${className}`}>
      <div className={contentLayout}>
        {hasActions ? <div aria-hidden="true" /> : null}
        <h1
          id={id}
          className={`font-mono text-2xl font-normal tracking-tight ${alignmentClass} ${titleClassName}`}
        >
          {title}
        </h1>
        {hasActions ? (
          <div className="flex items-center justify-end gap-3">{children}</div>
        ) : null}
      </div>
    </Card>
  );
}

export default function SettingsRow({
  label,
  description,
  children,
  className = "",
  hideDivider = false,
  compact = false,
  mono = false,
  stack = false,
}) {
  return (
    <div
      className={`${
        stack ? "flex flex-col gap-3 md:flex-row md:items-center md:justify-between" : "flex items-center justify-between"
      } ${
        compact ? "py-1" : "py-3"
      } px-4 ${
        hideDivider ? "" : "border-b border-primary/10"
      } ${className}`}
    >
      <div className={stack ? "md:flex-1 md:min-w-0 md:pr-4" : "flex-1 min-w-0 pr-4"}>
        <div className={`text-primary ${mono ? 'font-mono' : ''}`}>{label}</div>
        {description && (
          <div className="text-sm text-accent mt-0.5">{description}</div>
        )}
      </div>
      <div className={stack ? "flex justify-center md:flex-none" : "flex-shrink-0"}>{children}</div>
    </div>
  );
}
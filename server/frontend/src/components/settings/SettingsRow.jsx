export default function SettingsRow({
  label,
  description,
  children,
  className = "",
  hideDivider = false,
  compact = false,
  mono = false,
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        compact ? "py-1" : "py-3"
      } px-4 ${
        hideDivider ? "" : "border-b border-primary/10"
      } ${className}`}
    >
      <div className="flex-1 min-w-0 pr-4">
        <div className={`text-primary ${mono ? 'font-mono' : ''}`}>{label}</div>
        {description && (
          <div className="text-sm text-accent mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
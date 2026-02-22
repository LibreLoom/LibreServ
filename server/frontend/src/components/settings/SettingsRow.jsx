export default function SettingsRow({
  label,
  description,
  children,
  className = "",
}) {
  return (
    <div
      className={`flex items-center justify-between py-3 px-4 border-b border-primary/10 last:border-b-0 ${className}`}
    >
      <div className="flex-1 min-w-0 pr-4">
        <div className="font-medium text-primary">{label}</div>
        {description && (
          <div className="text-sm text-accent mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
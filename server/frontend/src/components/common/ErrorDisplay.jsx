import { X, AlertCircle, AlertTriangle, Info } from "lucide-react";

const primaryBtn =
"inline-flex items-center gap-2 rounded-pill bg-secondary text-primary px-4 py-2 text-sm font-medium " +
   "motion-safe:transition-all hover:bg-primary hover:text-secondary hover:ring-2 hover:ring-accent " +
   "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

const secondaryBtn =
  "inline-flex items-center gap-2 rounded-pill bg-transparent text-secondary px-4 py-2 text-sm font-medium " +
"motion-safe:transition-all hover:bg-secondary hover:text-primary hover:ring-0 " +
   "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

export function ErrorDisplay({
  message,
  type = "error",
  onDismiss,
  dismissible = true,
  children,
}) {
  const styles = {
    error: {
      bg: "bg-error/10",
      icon: AlertCircle,
      iconColor: "text-error",
      text: "text-error",
    },
    warning: {
      bg: "bg-warning/10",
      icon: AlertTriangle,
      iconColor: "text-warning",
      text: "text-warning",
    },
    info: {
      bg: "bg-info/10",
      icon: Info,
      iconColor: "text-info",
      text: "text-info",
    },
  };

  const style = styles[type];
  const Icon = style.icon;

  return (
    <div className={`${style.bg} rounded-large-element p-4 mb-4`}>
      <div className="flex items-start gap-3">
        <Icon className={`w-5 h-5 ${style.iconColor} shrink-0 mt-0.5`} />
        <div className="flex-1 min-w-0">
          <p className={`${style.text} font-medium`}>{message}</p>
          {children && <div className="mt-3">{children}</div>}
        </div>
        {dismissible && onDismiss && (
          <button
            onClick={onDismiss}
            className={`${style.iconColor} hover:bg-primary/20 motion-safe:transition-all shrink-0 rounded-pill p-1.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2`}
            aria-label="Dismiss error"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export function InlineError({ message, className = "" }) {
  if (!message) return null;

  return (
    <span className={`text-error text-sm ${className}`} role="alert">
      {message}
    </span>
  );
}

export function FormErrorSummary({ errors, onRetry }) {
  const errorEntries = Object.entries(errors).filter(([_, value]) => value);

  if (errorEntries.length === 0) return null;

  return (
    <ErrorDisplay
      message="Please fix the following errors:"
      type="error"
      dismissible={false}
    >
      <ul className="list-disc list-inside mt-2 space-y-1 text-error/80 text-sm">
        {errorEntries.map(([field, error]) => (
          <li key={field}>
            <span className="capitalize">{field.replace(/_/g, " ")}</span>:{" "}
            {error}
          </li>
        ))}
      </ul>
      {onRetry && (
        <button onClick={onRetry} className={primaryBtn}>
          Try Again
        </button>
      )}
    </ErrorDisplay>
  );
}

export function ApiError({ error, onRetry, onDismiss }) {
  if (!error) return null;

  const message = error.message || "An unexpected error occurred";

  return (
    <ErrorDisplay message={message} type="error" onDismiss={onDismiss}>
      {onRetry && (
        <div className="flex gap-2">
          <button onClick={onRetry} className={primaryBtn}>
            Retry
          </button>
          {onDismiss && (
            <button onClick={onDismiss} className={secondaryBtn}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </ErrorDisplay>
  );
}

export default ErrorDisplay;

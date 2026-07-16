import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import PropTypes from "prop-types";
import Callout from "./Callout";

const TONE_MAP = { error: "error", warning: "warning", info: "info" };
const ICON_MAP = { error: AlertCircle, warning: AlertTriangle, info: Info };

const primaryBtn =
  cn("inline-flex items-center gap-2 rounded-pill bg-secondary text-primary px-4 py-2 text-sm font-medium",
    "motion-safe:transition-all hover:bg-primary hover:text-secondary hover:ring-2 hover:ring-accent",
    "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2");

const secondaryBtn =
  cn("inline-flex items-center gap-2 rounded-pill bg-transparent text-secondary px-4 py-2 text-sm font-medium",
    "motion-safe:transition-all hover:bg-secondary hover:text-primary hover:ring-0",
    "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2");

/**
 * @param {{ message: any, type?: string, onDismiss?: any, dismissible?: boolean, children?: any }} _
 */
export function ErrorDisplay({
  message,
  type = "error",
  onDismiss,
  dismissible = true,
  children,
}) {
  return (
    <div className={cn("mb-4")} data-slot="error-display">
      <Callout
        tone={TONE_MAP[type] || "error"}
        icon={ICON_MAP[type] || ICON_MAP.error}
        onDismiss={dismissible && onDismiss ? onDismiss : undefined}
      >
        <p className="font-medium">{message}</p>
        {children && <div className="mt-3">{children}</div>}
      </Callout>
    </div>
  );
}

export function InlineError({ message, className = "" }) {
  if (!message) return null;

  return (
    <span className={cn("text-error text-sm", className)} role="alert">
      {message}
    </span>
  );
}

/** @param {{ errors: any, onRetry?: any }} _ */
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

/** @param {{ error: any, onRetry?: any, onDismiss?: any }} _ */
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

ErrorDisplay.propTypes = {
  message: PropTypes.string,
  type: PropTypes.oneOf(["error", "warning", "info"]),
  onDismiss: PropTypes.func,
  dismissible: PropTypes.bool,
  children: PropTypes.node,
};

InlineError.propTypes = {
  message: PropTypes.string,
  className: PropTypes.string,
};

FormErrorSummary.propTypes = {
  errors: PropTypes.object,
  onRetry: PropTypes.func,
};

ApiError.propTypes = {
  error: PropTypes.shape({
    message: PropTypes.string,
  }),
  onRetry: PropTypes.func,
  onDismiss: PropTypes.func,
};
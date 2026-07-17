import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import PropTypes from "prop-types";
import Callout from "./Callout";
import Button from "../ui/Button";

const TONE_MAP = { error: "error", warning: "warning", info: "info" };
const ICON_MAP = { error: AlertCircle, warning: AlertTriangle, info: Info };

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
        <Button variant="secondary" surface="primary" onClick={onRetry}>
          Try Again
        </Button>
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
          <Button variant="secondary" surface="primary" onClick={onRetry}>
            Retry
          </Button>
          {onDismiss && (
            <Button variant="outline" surface="primary" onClick={onDismiss}>
              Dismiss
            </Button>
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
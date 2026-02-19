import { X, AlertCircle, AlertTriangle, Info } from 'lucide-react';

const solidPill =
  "inline-flex items-center gap-2 rounded-pill bg-primary text-secondary px-4 py-2 text-sm font-medium " +
  "motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-2 hover:outline-primary " +
  "focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

const ghostPill =
  "inline-flex items-center gap-2 rounded-pill bg-transparent text-secondary px-4 py-2 text-sm font-medium outline-2 outline-accent " +
  "motion-safe:transition-all hover:bg-primary hover:text-secondary hover:outline-0 " +
  "focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

export function ErrorDisplay({ 
  message, 
  type = 'error', 
  onDismiss, 
  dismissible = true,
  children 
}) {
  const styles = {
    error: {
      bg: 'bg-error/10',
      icon: AlertCircle,
      iconColor: 'text-error',
      text: 'text-error',
    },
    warning: {
      bg: 'bg-warning/10',
      icon: AlertTriangle,
      iconColor: 'text-warning',
      text: 'text-warning',
    },
    info: {
      bg: 'bg-info/10',
      icon: Info,
      iconColor: 'text-info',
      text: 'text-info',
    },
  };

  const style = styles[type];
  const Icon = style.icon;

  return (
    <div className={`${style.bg} rounded-large-element p-4 mb-4`}>
      <div className="flex items-start gap-3">
        <Icon className={`w-5 h-5 ${style.iconColor} flex-shrink-0 mt-0.5`} />
        <div className="flex-1 min-w-0">
          <p className={`${style.text} font-medium`}>{message}</p>
          {children && <div className="mt-3">{children}</div>}
        </div>
        {dismissible && onDismiss && (
          <button
            onClick={onDismiss}
            className={`${style.text} hover:opacity-70 motion-safe:transition-opacity flex-shrink-0 focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 rounded-pill p-1`}
            aria-label="Dismiss error"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function InlineError({ message, className = '' }) {
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
            <span className="capitalize">{field.replace(/_/g, ' ')}</span>: {error}
          </li>
        ))}
      </ul>
      {onRetry && (
        <button onClick={onRetry} className={solidPill}>
          Try Again
        </button>
      )}
    </ErrorDisplay>
  );
}

export function ApiError({ error, onRetry, onDismiss }) {
  if (!error) return null;

  const message = error.message || 'An unexpected error occurred';

  return (
    <ErrorDisplay
      message={message}
      type="error"
      onDismiss={onDismiss}
    >
      {onRetry && (
        <div className="flex gap-2">
          <button onClick={onRetry} className={solidPill}>
            Retry
          </button>
          {onDismiss && (
            <button onClick={onDismiss} className={ghostPill}>
              Dismiss
            </button>
          )}
        </div>
      )}
    </ErrorDisplay>
  );
}

export default ErrorDisplay;

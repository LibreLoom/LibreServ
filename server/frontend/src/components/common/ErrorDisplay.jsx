import { X, AlertCircle, AlertTriangle, Info } from 'lucide-react';

/**
 * Error Display Component
 * 
 * Displays error messages in different styles based on severity.
 * Can be used inline in forms or as standalone alerts.
 * 
 * @param {Object} props
 * @param {string} props.message - Error message to display
 * @param {string} props.type - Error type: 'error' | 'warning' | 'info'
 * @param {Function} props.onDismiss - Callback when user dismisses the error
 * @param {boolean} props.dismissible - Whether the error can be dismissed
 * @param {React.ReactNode} props.children - Additional content (e.g., retry button)
 */
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
      border: 'border-error/20',
      icon: AlertCircle,
      iconColor: 'text-error',
      text: 'text-error',
    },
    warning: {
      bg: 'bg-warning/10',
      border: 'border-warning/20',
      icon: AlertTriangle,
      iconColor: 'text-warning',
      text: 'text-warning',
    },
    info: {
      bg: 'bg-info/10',
      border: 'border-info/20',
      icon: Info,
      iconColor: 'text-info',
      text: 'text-info',
    },
  };

  const style = styles[type];
  const Icon = style.icon;

  return (
    <div className={`${style.bg} border ${style.border} rounded-lg p-4 mb-4`}>
      <div className="flex items-start gap-3">
        <Icon className={`w-5 h-5 ${style.iconColor} flex-shrink-0 mt-0.5`} />
        <div className="flex-1 min-w-0">
          <p className={`${style.text} font-medium`}>{message}</p>
          {children && <div className="mt-3">{children}</div>}
        </div>
        {dismissible && onDismiss && (
          <button
            onClick={onDismiss}
            className={`${style.text} hover:opacity-70 transition-opacity flex-shrink-0`}
            aria-label="Dismiss error"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline Error Component for forms
 * 
 * @param {Object} props
 * @param {string} props.message - Error message
 * @param {string} props.className - Additional CSS classes
 */
export function InlineError({ message, className = '' }) {
  if (!message) return null;
  
  return (
    <span className={`text-error text-sm ${className}`} role="alert">
      {message}
    </span>
  );
}

/**
 * Form Error Summary Component
 * 
 * Displays a summary of all form errors
 * 
 * @param {Object} props
 * @param {Object} props.errors - Object with field names as keys and error messages as values
 * @param {Function} props.onRetry - Callback to retry the action
 */
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
        <button
          onClick={onRetry}
          className="mt-3 px-4 py-2 bg-accent text-primary rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors"
        >
          Try Again
        </button>
      )}
    </ErrorDisplay>
  );
}

/**
 * API Error Component
 * 
 * Displays API errors with automatic retry functionality
 * 
 * @param {Object} props
 * @param {Error} props.error - The error object
 * @param {Function} props.onRetry - Callback to retry the failed operation
 * @param {Function} props.onDismiss - Callback to dismiss the error
 */
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
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-accent text-primary rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            Retry
          </button>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="px-4 py-2 bg-surface text-secondary rounded-lg text-sm font-medium border border-secondary/20 hover:bg-surface/80 transition-colors"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </ErrorDisplay>
  );
}

export default ErrorDisplay;

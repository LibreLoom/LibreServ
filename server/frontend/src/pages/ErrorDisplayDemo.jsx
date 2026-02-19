import { useState } from 'react';
import { ErrorDisplay, InlineError, FormErrorSummary, ApiError } from '../components/common/ErrorDisplay';

export default function ErrorDisplayDemo() {
  const [showError, setShowError] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showInlineError, setShowInlineError] = useState(false);
  const [showFormError, setShowFormError] = useState(false);
  const [apiError, setApiError] = useState(null);

  const triggerApiError = () => {
    const error = new Error('API request failed: 500 Internal Server Error');
    setApiError(error);
  };

  return (
    <div className="p-8 bg-primary text-secondary space-y-8">
      <h1 className="text-2xl font-mono">Error Display Demo</h1>
      
      <div className="space-y-4">
        <h2 className="text-xl font-mono">Standard Errors</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setShowError(!showError)}
            className="rounded-pill bg-primary text-secondary px-4 py-2 font-medium hover:bg-secondary hover:text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
          >
            Toggle Error
          </button>
          <button
            onClick={() => setShowWarning(!showWarning)}
            className="rounded-pill bg-primary text-secondary px-4 py-2 font-medium hover:bg-secondary hover:text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
          >
            Toggle Warning
          </button>
          <button
            onClick={() => setShowInfo(!showInfo)}
            className="rounded-pill bg-primary text-secondary px-4 py-2 font-medium hover:bg-secondary hover:text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
          >
            Toggle Info
          </button>
        </div>

        {showError && (
          <ErrorDisplay
            message="This is an error message"
            type="error"
            onDismiss={() => setShowError(false)}
          />
        )}

        {showWarning && (
          <ErrorDisplay
            message="This is a warning message"
            type="warning"
            onDismiss={() => setShowWarning(false)}
          />
        )}

        {showInfo && (
          <ErrorDisplay
            message="This is an info message"
            type="info"
            onDismiss={() => setShowInfo(false)}
          />
        )}
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-mono">Inline Error</h2>
        <button
          onClick={() => setShowInlineError(!showInlineError)}
          className="rounded-pill bg-primary text-secondary px-4 py-2 font-medium hover:bg-secondary hover:text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
        >
          Toggle Inline Error
        </button>
        {showInlineError && <InlineError message="This is an inline error" />}
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-mono">Form Error Summary</h2>
        <button
          onClick={() => setShowFormError(!showFormError)}
          className="rounded-pill bg-primary text-secondary px-4 py-2 font-medium hover:bg-secondary hover:text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
        >
          Toggle Form Errors
        </button>
        {showFormError && (
          <FormErrorSummary
            errors={{ username: 'Username is required', email: 'Invalid email format' }}
            onRetry={() => console.log('Retry')}
          />
        )}
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-mono">API Error</h2>
        <button
          onClick={triggerApiError}
          className="rounded-pill bg-primary text-secondary px-4 py-2 font-medium hover:bg-secondary hover:text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
        >
          Trigger API Error
        </button>
        <button
          onClick={() => setApiError(null)}
          className="rounded-pill bg-primary text-secondary px-4 py-2 font-medium hover:bg-secondary hover:text-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
        >
          Clear API Error
        </button>
        {apiError && <ApiError error={apiError} onRetry={triggerApiError} onDismiss={() => setApiError(null)} />}
      </div>
    </div>
  );
}

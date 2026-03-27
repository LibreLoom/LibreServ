import { useState } from 'react';
import ErrorBoundary from '../components/ui/ErrorBoundary';

export default function ErrorBoundaryDemo() {
  const [throwError, setThrowError] = useState(false);

  if (throwError) {
    throw new Error('Demo error - this is a test of the error boundary');
  }

  return (
    <div className="p-8 bg-primary text-secondary">
      <h1 className="text-2xl font-mono mb-4">Error Boundary Demo</h1>
      <p className="mb-4">Click the button below to trigger a test error:</p>
      <button
        onClick={() => setThrowError(true)}
        className="rounded-pill bg-primary text-secondary px-6 py-3 font-medium hover:bg-secondary hover:text-primary focus-visible:ring-2 focus-visible:ring-accent"
      >
        Trigger Error
      </button>
    </div>
  );
}

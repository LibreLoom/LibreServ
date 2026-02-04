import { Component } from 'react';
import { AlertTriangle, RefreshCw, Home, Bug } from 'lucide-react';

/**
 * Error Boundary Component
 * 
 * Catches JavaScript errors anywhere in the child component tree,
 * logs those errors, and displays a fallback UI instead of crashing.
 * 
 * Usage:
 * <ErrorBoundary>
 *   <YourComponent />
 * </ErrorBoundary>
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { 
      hasError: false, 
      error: null, 
      errorInfo: null 
    };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Log error details (in production, send to error tracking service)
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    
    this.setState({
      error,
      errorInfo
    });

    // In production, you would send to an error tracking service like Sentry
    // if (process.env.NODE_ENV === 'production') {
    //   sendErrorToService(error, errorInfo);
    // }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = '/';
  };

  handleGoBack = () => {
    window.history.back();
  };

  render() {
    if (this.state.hasError) {
      // Render fallback UI
      return (
        <div className="min-h-screen bg-primary flex items-center justify-center p-4">
          <div className="max-w-lg w-full">
            {/* Error Icon */}
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 bg-error/10 rounded-full flex items-center justify-center">
                <AlertTriangle className="w-10 h-10 text-error" />
              </div>
            </div>

            {/* Error Title */}
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-secondary mb-2">
                Something went wrong
              </h1>
              <p className="text-secondary/70">
                We apologize for the inconvenience. An unexpected error has occurred.
              </p>
            </div>

            {/* Error Details (Development Only) */}
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <div className="bg-surface border border-error/20 rounded-lg p-4 mb-6">
                <div className="flex items-center gap-2 mb-3 text-error">
                  <Bug className="w-5 h-5" />
                  <span className="font-semibold">Error Details (Development)</span>
                </div>
                <div className="bg-primary/50 rounded p-3 font-mono text-sm text-secondary/80 overflow-x-auto">
                  <p className="text-error mb-2">{this.state.error.toString()}</p>
                  {this.state.errorInfo && (
                    <pre className="text-xs text-secondary/60 whitespace-pre-wrap">
                      {this.state.errorInfo.componentStack}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="space-y-3">
              <button
                onClick={this.handleReload}
                className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent/90 text-primary font-semibold py-3 px-6 rounded-lg transition-colors"
              >
                <RefreshCw className="w-5 h-5" />
                Reload Page
              </button>

              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={this.handleGoBack}
                  className="flex items-center justify-center gap-2 bg-surface hover:bg-surface/80 text-secondary font-semibold py-3 px-6 rounded-lg border border-secondary/20 transition-colors"
                >
                  Go Back
                </button>

                <button
                  onClick={this.handleGoHome}
                  className="flex items-center justify-center gap-2 bg-surface hover:bg-surface/80 text-secondary font-semibold py-3 px-6 rounded-lg border border-secondary/20 transition-colors"
                >
                  <Home className="w-5 h-5" />
                  Go Home
                </button>
              </div>
            </div>

            {/* Support Info */}
            <div className="mt-8 text-center text-sm text-secondary/50">
              <p>If this problem persists, please contact support.</p>
              <p className="mt-1">Error ID: {Math.random().toString(36).substr(2, 9).toUpperCase()}</p>
            </div>
          </div>
        </div>
      );
    }

    // Render children if no error
    return this.props.children;
  }
}

/**
 * Error Boundary with Fallback Component
 * 
 * Allows passing a custom fallback component for specific error UIs
 */
export class ErrorBoundaryWithFallback extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error);
      }
      return <ErrorBoundary />;
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

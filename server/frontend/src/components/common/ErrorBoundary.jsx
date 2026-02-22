import { Component } from "react";
import { AlertTriangle, RefreshCw, Home, Bug } from "lucide-react";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);

    this.setState({
      error,
      errorInfo,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleGoHome = () => {
    window.location.href = "/";
  };

  handleGoBack = () => {
    window.history.back();
  };

  render() {
    if (this.state.hasError) {
      const primaryBtn =
        "inline-flex items-center justify-center gap-2 rounded-pill bg-secondary text-primary px-6 py-3 font-medium " +
        "motion-safe:transition-all hover:bg-primary hover:text-secondary hover:ring-2 hover:ring-accent " +
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

      const secondaryBtn =
        "inline-flex items-center justify-center gap-2 rounded-pill bg-transparent text-secondary px-6 py-3 font-medium outline-2 outline-secondary/30 " +
        "motion-safe:transition-all hover:bg-secondary hover:text-primary hover:outline-0 " +
        "focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

      return (
        <div className="min-h-screen bg-primary flex items-center justify-center p-4">
          <div className="max-w-lg w-full">
            <div className="flex justify-center mb-6">
              <div className="w-20 h-20 rounded-pill bg-error/10 flex items-center justify-center">
                <AlertTriangle className="w-10 h-10 text-error" />
              </div>
            </div>

            <div className="text-center mb-8">
              <h1 className="text-2xl font-mono text-secondary mb-2">
                Something went wrong
              </h1>
              <p className="text-secondary/70">
                We apologize for the inconvenience. An unexpected error has
                occurred.
              </p>
            </div>

            {import.meta.env.DEV && this.state.error && (
              <div className="bg-secondary text-primary rounded-large-element p-5 mb-6 outline-2 outline-accent/30">
                <div className="flex items-center gap-2 mb-4">
                  <Bug className="w-5 h-5 text-accent" />
                  <span className="font-mono font-medium text-secondary">
                    Error Details (Development)
                  </span>
                </div>
                <div className="bg-primary rounded-large-element p-4 font-mono text-sm overflow-x-auto border border-secondary/20">
                  <div className="mb-3">
                    <span className="text-secondary/60 text-xs uppercase tracking-wider mb-1 block">Error</span>
                    <p className="text-error font-medium break-all">
                      {this.state.error.toString()}
                    </p>
                  </div>
                  {this.state.errorInfo && (
                    <div>
                      <span className="text-secondary/60 text-xs uppercase tracking-wider mb-1 block">Stack Trace</span>
                      <pre className="text-xs text-secondary/70 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                        {this.state.errorInfo.componentStack}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <button
                onClick={this.handleReload}
                className={`w-full ${primaryBtn}`}
              >
                <RefreshCw className="w-5 h-5" />
                Reload Page
              </button>

              <div className="grid grid-cols-2 gap-3">
                <button onClick={this.handleGoBack} className={secondaryBtn}>
                  Go Back
                </button>

                <button onClick={this.handleGoHome} className={secondaryBtn}>
                  <Home className="w-5 h-5" />
                  Go Home
                </button>
              </div>
            </div>

            <div className="mt-8 text-center text-sm text-secondary/50">
              <p>If this problem persists, please contact support.</p>
              <p className="mt-1">
                Error ID:{" "}
                {Math.random().toString(36).substr(2, 9).toUpperCase()}
              </p>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export class ErrorBoundaryWithFallback extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
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

import { Component } from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle, RefreshCw, Home, Bug } from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button";

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
      return (
        <div className={cn("min-h-screen bg-primary flex items-center justify-center p-4")} data-slot="error-boundary">
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

             {/** @type {any} */ (import.meta).env?.DEV && this.state.error && (
               <div className="bg-secondary text-primary rounded-large-element p-5 mb-6 ring-2 ring-accent/30">
                 <div className="flex items-center gap-2 mb-4">
                   <Bug className="w-5 h-5 text-accent" />
                   <span className="font-mono font-medium text-primary">
                     Error Details (Development)
                   </span>
                 </div>
                 <div className="bg-primary text-secondary rounded-large-element p-4 font-mono text-sm overflow-x-auto border border-secondary/20">
                   <div className="mb-3">
                     <span className="text-secondary/60 text-xs uppercase tracking-wider mb-1 block">
                       Error
                     </span>
                     <p className="text-error font-medium break-all">
                       {this.state.error.toString()}
                     </p>
                   </div>
                   {this.state.errorInfo && (
                     <div>
                       <span className="text-secondary/60 text-xs uppercase tracking-wider mb-1 block">
                         Stack Trace
                       </span>
                       <pre className="text-xs text-secondary/70 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                         {this.state.errorInfo.componentStack}
                       </pre>
                     </div>
                   )}
                 </div>
               </div>
             )}

            <div className="space-y-3">
              <Button
                variant="secondary"
                surface="primary"
                size="lg"
                fullWidth
                onClick={this.handleReload}
              >
                <RefreshCw className="w-5 h-5" />
                Reload Page
              </Button>

              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  surface="primary"
                  size="lg"
                  onClick={this.handleGoBack}
                >
                  Go Back
                </Button>

                <Button
                  variant="outline"
                  surface="primary"
                  size="lg"
                  onClick={this.handleGoHome}
                >
                  <Home className="w-5 h-5" />
                  Go Home
                </Button>
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

export default ErrorBoundary;

ErrorBoundary.propTypes = {
  children: PropTypes.node,
};

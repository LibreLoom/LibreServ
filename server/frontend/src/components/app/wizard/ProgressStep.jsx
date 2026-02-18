import { memo, useEffect, useState } from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

const INSTALL_PHASES = [
  { id: "preparing", label: "Preparing installation" },
  { id: "downloading", label: "Downloading application" },
  { id: "configuring", label: "Setting up configuration" },
  { id: "starting", label: "Starting services" },
  { id: "verifying", label: "Verifying installation" },
];

function ProgressStep({ instanceId, onComplete, onError }) {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [status, setStatus] = useState("installing");
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!instanceId) return;

    const pollStatus = async () => {
      try {
        const res = await fetch(`/api/v1/apps/${instanceId}/status`, {
          credentials: "include",
        });

        if (!res.ok) {
          throw new Error("Failed to check status");
        }

        const data = await res.json();
        setStatus(data.status);

        if (data.status === "running") {
          setCurrentPhase(INSTALL_PHASES.length);
          setTimeout(() => onComplete(data), 1000);
        } else if (data.status === "error") {
          setError("Installation failed. Please try again.");
          onError(new Error("Installation failed"));
        } else if (data.status === "installing") {
          setCurrentPhase((prev) => Math.min(prev + 1, INSTALL_PHASES.length - 1));
        }
      } catch (err) {
        console.error("Status poll error:", err);
      }
    };

    const interval = setInterval(pollStatus, 2000);
    const phaseInterval = setInterval(() => {
      setCurrentPhase((prev) => Math.min(prev + 0.5, INSTALL_PHASES.length - 1));
    }, 1500);

    pollStatus();

    return () => {
      clearInterval(interval);
      clearInterval(phaseInterval);
    };
  }, [instanceId, onComplete, onError]);

  if (error) {
    return (
      <div className="space-y-6 text-center">
        <XCircle className="mx-auto text-accent" size={48} />
        <div className="space-y-2">
          <h2 className="font-mono text-2xl font-normal text-secondary">
            Installation Failed
          </h2>
          <p className="text-secondary/70">{error}</p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2 rounded-pill bg-accent text-primary hover:bg-accent/90 motion-safe:transition-all font-mono"
        >
          Try Again
        </button>
      </div>
    );
  }

  const isComplete = status === "running";

  return (
    <div className="space-y-8">
      <div className="text-center space-y-4">
        {isComplete ? (
          <CheckCircle className="mx-auto text-accent" size={48} />
        ) : (
          <Loader2 className="mx-auto text-accent animate-spin" size={48} />
        )}
        <h2 className="font-mono text-2xl font-normal text-secondary">
          {isComplete ? "Almost Ready!" : "Installing..."}
        </h2>
        <p className="text-secondary/70">
          {isComplete
            ? "Your app is starting up. This won't take long."
            : "Please wait while we set things up."}
        </p>
      </div>

      <div className="max-w-md mx-auto space-y-3">
        {INSTALL_PHASES.map((phase, index) => {
          const isPast = index < Math.floor(currentPhase);
          const isCurrent = index === Math.floor(currentPhase) && !isComplete;
          const isDone = isComplete || isPast;

          return (
            <div
              key={phase.id}
              className={`
                flex items-center gap-3 p-3 rounded-large-element
                motion-safe:transition-all
                ${isDone ? "bg-accent/20" : isCurrent ? "bg-secondary/10" : "bg-secondary/5"}
              `}
            >
              <div
                className={`
                  flex h-6 w-6 items-center justify-center rounded-full
                  ${isDone ? "bg-accent text-primary" : isCurrent ? "border-2 border-accent" : "border-2 border-secondary/30"}
                `}
              >
                {isDone ? (
                  <CheckCircle size={14} />
                ) : isCurrent ? (
                  <div className="h-2 w-2 rounded-full bg-accent animate-pulse" />
                ) : (
                  <div className="h-2 w-2 rounded-full bg-secondary/30" />
                )}
              </div>
              <span
                className={`
                  font-mono text-sm
                  ${isDone ? "text-secondary" : isCurrent ? "text-secondary" : "text-secondary/50"}
                `}
              >
                {phase.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(ProgressStep);

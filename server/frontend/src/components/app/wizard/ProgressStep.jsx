import { memo, useEffect, useState, useRef } from "react";
import { CheckCircle, XCircle } from "lucide-react";
import TypewriterLoader from "../../../components/ui/TypewriterLoader";

const INSTALL_PHASES = [
  { id: "preparing", label: "Preparing installation" },
  { id: "downloading", label: "Downloading application" },
  { id: "configuring", label: "Setting up configuration" },
  { id: "starting", label: "Starting services" },
  { id: "verifying", label: "Verifying installation" },
];

function ProgressStep({ instanceId, onComplete }) {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [status, setStatus] = useState("installing");
  const [error, setError] = useState(null);
  const hasCompleted = useRef(false);
  const consecutive404Count = useRef(0);

  useEffect(() => {
    if (!instanceId || hasCompleted.current) return;

    const pollStatus = async () => {
      if (hasCompleted.current) return;

      try {
        const res = await fetch(`/api/v1/apps/${instanceId}/status`, {
          credentials: "include",
        });

        if (res.status === 404) {
          consecutive404Count.current += 1;
          
          // Try to read the actual error message from the response
          let errorMessage = "Installation status not available";
          try {
            const errorData = await res.json();
            if (errorData.error) {
              errorMessage = errorData.error;
            }
          } catch {
            // Ignore JSON parsing errors
          }
          
          // If we get multiple consecutive 404s, check if app still exists
          if (consecutive404Count.current >= 3) {
            // Before showing error, check if app exists via main endpoint
            try {
              const appCheckRes = await fetch(`/api/v1/apps/${instanceId}`, {
                credentials: "include",
              });
              
              if (appCheckRes.ok) {
                // App exists but status endpoint returns 404 - this is weird but installation might still be in progress
                console.warn(`App exists but status endpoint returns 404: ${errorMessage}, continuing to poll...`);
                consecutive404Count.current = 2; // Reset to 2 to give more time
                return;
              }
            } catch (checkErr) {
              console.warn("Failed to check app existence:", checkErr);
            }
            
            hasCompleted.current = true;
            setError(`Unable to check installation status: ${errorMessage}. Check the app list to see if installation completed.`);
            return;
          }
          
          // For first few 404s, just log and continue polling
          console.warn(`App status 404 (attempt ${consecutive404Count.current}/3): ${errorMessage}, continuing to poll...`);
          return;
        } else {
          // Reset 404 counter on successful response
          consecutive404Count.current = 0;
        }

        if (!res.ok) {
          // For non-404 errors, try to read error message
          let errorMessage = "Failed to check status";
          try {
            const errorData = await res.json();
            if (errorData.error) {
              errorMessage = errorData.error;
            }
          } catch {
            // Ignore JSON parsing errors
          }
          throw new Error(errorMessage);
        }

        const data = await res.json();
        setStatus(data.status);

        if (data.status === "running") {
          hasCompleted.current = true;
          setCurrentPhase(INSTALL_PHASES.length);
          setTimeout(() => onComplete(data), 1000);
        } else if (data.status === "error") {
          hasCompleted.current = true;
          setError(data.error || "Installation failed. Please try again.");
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
  }, [instanceId, onComplete]);

  if (error) {
    return (
      <div className="space-y-6 text-center">
        <XCircle className="mx-auto text-secondary" size={48} />
        <div className="space-y-2">
          <h2 className="font-mono text-2xl font-normal text-secondary">
            Installation Failed
          </h2>
          <p className="text-secondary/70">{error}</p>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="px-6 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/90 motion-safe:transition-all font-mono"
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
          <TypewriterLoader message="Installing..." size="lg" />
        )}
        <h2 className="font-mono text-2xl font-normal text-secondary">
          {isComplete ? "Almost Ready!" : ""}
        </h2>
        <p className="text-secondary/70">
          {isComplete
            ? "Your app is starting up. This won't take long."
            : "Please wait while we set things up. You can leave this page; installation will continue in the background."}
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
                flex items-center gap-3 p-3 rounded-pill
                motion-safe:transition-all
                ${isDone ? "bg-secondary/20" : isCurrent ? "bg-secondary/10" : "bg-secondary/5"}
              `}
            >
              <div
                className={`
                  flex h-6 w-6 items-center justify-center rounded-full
                  ${isDone ? "bg-accent text-primary" : isCurrent ? "border-2 border-secondary" : "border-2 border-secondary/30"}
                `}
              >
                {isDone ? (
                  <CheckCircle size={14} />
                ) : isCurrent ? (
                  <div className="h-2 w-2 rounded-full bg-secondary animate-pulse" />
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

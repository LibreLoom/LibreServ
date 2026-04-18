import { memo, useEffect, useState, useRef, useCallback } from "react";
import { CheckCircle, XCircle, Copy, Check, ChevronDown } from "lucide-react";
import TypewriterLoader from "../../../components/ui/TypewriterLoader";
import Button from "../../../components/ui/Button";
import { useAuth } from "../../../hooks/useAuth";

const INSTALL_PHASES = [
  { id: "preparing", label: "Preparing installation" },
  { id: "downloading", label: "Downloading application" },
  { id: "configuring", label: "Setting up configuration" },
  { id: "starting", label: "Starting services" },
  { id: "verifying", label: "Verifying installation" },
  { id: "creating-route", label: "Creating subdomain route" },
  { id: "requesting-cert", label: "Requesting HTTPS certificate" },
];

function getErrorSummary(error) {
  if (!error) return "Application startup failed";
  return "Application startup failed";
}

function getErrorHint(error) {
  if (!error) return "We couldn't finish bringing the app online.";
  const lower = error.toLowerCase();
  if (lower.includes("port") && lower.includes("already")) {
    return "A required port is already in use on this system.";
  }
  if (lower.includes("compose") || lower.includes("container")) {
    return "The app's containers could not be started successfully.";
  }
  if (lower.includes("network")) {
    return "Container networking could not be configured.";
  }
  return "We couldn't finish bringing the app online.";
}

function ProgressStep({ instanceId, onComplete }) {
  const { request } = useAuth();
  const [currentPhase, setCurrentPhase] = useState(0);
  const [status, setStatus] = useState("installing");
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [streamLines, setStreamLines] = useState([]);
  const [streamCopied, setStreamCopied] = useState(false);
  const hasCompleted = useRef(false);
  const consecutive404Count = useRef(0);
  const streamRef = useRef(null);
  const streamOutputRef = useRef(null);

  const handleComplete = useCallback((data) => {
    if (hasCompleted.current) return;
    hasCompleted.current = true;
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    setTimeout(() => onComplete(data), 500);
  }, [onComplete]);

  // SSE stream for live output + phase advancement
  useEffect(() => {
    if (!instanceId || hasCompleted.current) return;

    const es = new EventSource(`/api/v1/apps/${instanceId}/install/stream`, { withCredentials: true });
    streamRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "complete") {
          handleComplete({ status: data.exit_code === 0 ? "running" : "error" });
          return;
        }

        if (data.type === "error") {
          if (!hasCompleted.current) {
            hasCompleted.current = true;
            setError(data.error || "Installation failed");
            es.close();
            streamRef.current = null;
          }
          return;
        }

        const content = data.content || data.error || "";
        if (content) {
          setStreamLines((prev) => [...prev, content]);
        }

        // Advance phase based on output patterns
        if (/pull|download|image/i.test(content)) {
          setCurrentPhase((prev) => Math.max(prev, 1));
        } else if (/compose up|starting/i.test(content)) {
          setCurrentPhase((prev) => Math.max(prev, 2));
        } else if (/system-setup|configur/i.test(content)) {
          setCurrentPhase((prev) => Math.max(prev, 3));
        } else if (/all containers running|verifying/i.test(content)) {
          setCurrentPhase((prev) => Math.max(prev, 4));
        } else if (/route|subdomain|nginx|caddy/i.test(content)) {
          setCurrentPhase((prev) => Math.max(prev, 5));
        } else if (/certificate|https|ssl|letsencrypt/i.test(content)) {
          setCurrentPhase((prev) => Math.max(prev, 6));
        }
      } catch {
        // Ignore parse errors for non-JSON SSE data
      }
    };

    es.onerror = () => {
      es.close();
      streamRef.current = null;
    };

    return () => {
      es.close();
      streamRef.current = null;
    };
  }, [instanceId, handleComplete]);

  // Auto-scroll stream output
  useEffect(() => {
    if (streamOutputRef.current) {
      streamOutputRef.current.scrollTop = streamOutputRef.current.scrollHeight;
    }
  }, [streamLines]);

  // Fallback polling in case SSE fails
  useEffect(() => {
    if (!instanceId || hasCompleted.current) return;

    const pollStatus = async () => {
      if (hasCompleted.current) return;

      try {
        const res = await request(`/apps/${instanceId}/status`);

        if (res.status === 404) {
          consecutive404Count.current += 1;

          let errorMessage = "Installation status not available";
          try {
            const errorData = await res.json();
            if (errorData.error) {
              errorMessage = errorData.error;
            }
          } catch {
            // Ignore JSON parsing errors
          }

          if (consecutive404Count.current >= 3) {
            try {
              const appCheckRes = await request(`/apps/${instanceId}`);

              if (appCheckRes.ok) {
                console.warn(`App exists but status endpoint returns 404: ${errorMessage}, continuing to poll...`);
                consecutive404Count.current = 2;
                return;
              }
            } catch (checkErr) {
              console.warn("Failed to check app existence:", checkErr);
            }

            hasCompleted.current = true;
            setError(`Unable to check installation status: ${errorMessage}. Check the app list to see if installation completed.`);
            return;
          }

          console.warn(`App status 404 (attempt ${consecutive404Count.current}/3): ${errorMessage}, continuing to poll...`);
          return;
        } else {
          consecutive404Count.current = 0;
        }

        if (!res.ok) {
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
          // Check if route was created
          try {
            const routesRes = await request("/network/routes");
            const routesData = await routesRes.json();
            const route = routesData.routes.find(r => r.app_id === instanceId);

            if (route) {
              setCurrentPhase(5); // Creating route
              // Check for certificate in Caddy status
              const caddyRes = await request("/network/status");
              const caddyData = await caddyRes.json();

              if (caddyData.domains && caddyData.domains.includes(`${route.subdomain}.${route.domain}`)) {
                setCurrentPhase(6); // Requesting cert (complete)
                handleComplete({ status: "running", subdomain: route.subdomain, domain: route.domain });
                return;
              }
              // Certificate not ready yet - will poll again via interval
            } else {
              handleComplete({ status: "running" });
              return;
            }
          } catch (err) {
            console.error("Route status poll error:", err);
            handleComplete({ status: "running" });
            return;
          }
        } else if (data.status === "error") {
          if (!hasCompleted.current) {
            hasCompleted.current = true;
            setError(data.error || "Installation failed. Please try again.");
          }
        } else if (data.status === "installing") {
          setCurrentPhase((prev) => Math.min(prev + 1, INSTALL_PHASES.length - 1));
        }
      } catch (err) {
        console.error("Status poll error:", err);
      }
    };

    const interval = setInterval(pollStatus, 10_000);

    pollStatus();

    return () => {
      clearInterval(interval);
    };
  }, [instanceId, handleComplete]);

  const handleCopyStream = async () => {
    const text = streamLines.join("");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStreamCopied(true);
      setTimeout(() => setStreamCopied(false), 2000);
    } catch {
      // Clipboard failed
    }
  };

  if (error) {
    const errorSummary = getErrorSummary(error);
    const errorHint = getErrorHint(error);

    const handleCopyError = async () => {
      try {
        await navigator.clipboard.writeText(error);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy error:", err);
      }
    };

    return (
      <div className="space-y-5 text-center">
        <XCircle className="mx-auto text-secondary" size={48} />
        <div className="space-y-3">
          <h2 className="font-mono text-2xl font-normal text-secondary">
            Installation Failed
          </h2>
          <p className="text-secondary/80">{errorSummary}</p>
          <p className="mx-auto max-w-md text-sm leading-relaxed text-secondary/60">
            {errorHint}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDetailsOpen((open) => !open)}
            className="border border-secondary/15 bg-primary/20 font-mono text-secondary hover:bg-secondary/10 hover:text-secondary"
            aria-expanded={detailsOpen}
            aria-controls="install-error-details"
          >
            <ChevronDown
              size={14}
              className={`motion-safe:transition-transform ${detailsOpen ? "rotate-180" : "rotate-0"}`}
            />
            {detailsOpen ? "Hide details" : "Show details"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopyError}
            className="border border-secondary/15 bg-primary/20 font-mono text-secondary hover:bg-secondary/10 hover:text-secondary"
          >
            {copied ? (
              <>
                <Check size={14} />
                Copied
              </>
            ) : (
              <>
                <Copy size={14} />
                Copy error
              </>
            )}
          </Button>
        </div>

        <div
          id="install-error-details"
          aria-hidden={!detailsOpen}
          className={`mx-auto w-full max-w-2xl overflow-hidden motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out ${
            detailsOpen
              ? "mt-1 max-h-96 opacity-100 translate-y-0"
              : "max-h-0 opacity-0 -translate-y-2 pointer-events-none"
          }`}
        >
          <div className="rounded-card border border-secondary/10 bg-primary/20 p-4 text-left motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out">
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-secondary/10 pb-3">
              <p className="font-mono text-sm text-secondary">Technical details</p>
              <p className="text-xs text-secondary/50">Useful for debugging or support</p>
            </div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-secondary/70">
              {error}
            </pre>
          </div>
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

      {/* Stream output toggle */}
      {streamLines.length > 0 && (
        <div className="mx-auto max-w-2xl">
          <button
            onClick={() => setDetailsOpen((open) => !open)}
            className={`group relative w-full overflow-hidden rounded-pill border px-5 py-3 text-left font-mono motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out ${
              detailsOpen
                ? "border-secondary/20 bg-secondary text-primary shadow-[0_16px_50px_rgba(0,0,0,0.12)]"
                : "border-secondary/15 bg-secondary/8 text-secondary hover:border-secondary/30 hover:bg-secondary/12 hover:shadow-[0_12px_34px_rgba(0,0,0,0.08)]"
            }`}
            aria-expanded={detailsOpen}
            aria-controls="install-live-output"
          >
            <span
              className={`pointer-events-none absolute inset-y-0 right-0 w-28 rounded-pill bg-gradient-to-l motion-safe:transition-opacity motion-safe:duration-300 ${
                detailsOpen ? "from-primary/20 to-transparent opacity-100" : "from-secondary/8 to-transparent opacity-0 group-hover:opacity-100"
              }`}
            />
            <span className="relative flex items-center justify-between gap-4">
              <span className="space-y-1">
                <span className={`block text-sm motion-safe:transition-colors ${detailsOpen ? "text-primary" : "text-secondary"}`}>
                  {detailsOpen ? "Installation output is open" : "View installation output"}
                </span>
                <span className={`block text-xs motion-safe:transition-colors ${detailsOpen ? "text-primary/70" : "text-secondary/60"}`}>
                  Live logs from image pull, setup, and startup checks.
                </span>
              </span>
              <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border motion-safe:transition-all motion-safe:duration-300 ${detailsOpen ? "border-primary/25 bg-primary/10" : "border-secondary/15 bg-primary/80 group-hover:scale-105"}`}>
                <ChevronDown
                  size={18}
                  className={`motion-safe:transition-transform motion-safe:duration-300 ${detailsOpen ? "rotate-180" : "rotate-0"}`}
                />
              </span>
            </span>
          </button>

          <div
            id="install-live-output"
            className={`overflow-hidden motion-safe:transition-all motion-safe:duration-400 motion-safe:ease-out ${
              detailsOpen ? "mt-3 max-h-72 translate-y-0 opacity-100" : "max-h-0 -translate-y-2 opacity-0 pointer-events-none"
            }`}
          >
            <div className="animate-dropdown-open rounded-[20px] border border-secondary/12 bg-primary/85 p-4 shadow-[0_22px_60px_rgba(0,0,0,0.12)] backdrop-blur-sm">
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-secondary/10 pb-3">
                <div>
                  <p className="font-mono text-sm text-secondary">Live installation output</p>
                  <p className="text-xs text-secondary/55">Helpful if setup stalls or you need details for debugging.</p>
                </div>
                <button
                  onClick={handleCopyStream}
                  className="inline-flex items-center gap-1 rounded-pill border border-secondary/12 bg-secondary/6 px-3 py-1.5 text-xs text-secondary/60 motion-safe:transition-colors hover:text-secondary"
                >
                  {streamCopied ? (
                    <>
                      <Check size={12} />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      Copy
                    </>
                  )}
                </button>
              </div>
                <pre
                  ref={streamOutputRef}
                  className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-large-element bg-secondary/5 px-4 py-3 font-mono text-xs leading-6 text-secondary/72"
                >
                  {streamLines.join("")}
                </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ProgressStep);

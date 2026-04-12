import { useState } from "react";
import { CheckCircle, XCircle, ChevronDown, ChevronUp, Clock, Copy, Check } from "lucide-react";
import ModalCard from "../../cards/ModalCard";

export function ActionResultModal({ result, onClose }) {
  const [showVerbose, setShowVerbose] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!result) return null;

  const formatDuration = (duration) => {
    if (!duration) return "N/A";
    if (typeof duration === "string") {
      const units = {
        h: 3600000,
        m: 60000,
        s: 1000,
        ms: 1,
        us: 0.001,
        "µs": 0.001,
        ns: 0.000001,
      };
      const matches = [...duration.matchAll(/(\d+(?:\.\d+)?)(h|ms|us|µs|ns|m|s)/g)];
      if (matches.length > 0) {
        const totalMs = matches.reduce((sum, [, value, unit]) => sum + parseFloat(value) * units[unit], 0);
        if (totalMs < 1000) return `${Math.round(totalMs)}ms`;
        const totalSeconds = totalMs / 1000;
        if (totalSeconds < 60) return `${Number(totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0))}s`;
        const totalMinutes = Math.floor(totalSeconds / 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        const seconds = Math.round(totalSeconds % 60);
        if (hours > 0) return `${hours}h ${minutes}m`;
        return `${totalMinutes}m ${seconds}s`;
      }
      return duration;
    }
    if (typeof duration === "number") {
      const milliseconds = duration / 1000000;
      if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
      const seconds = Math.round(milliseconds / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    }
    return String(duration);
  };

  const exitCode = result.exit_code;
  const output = typeof result.output === "string"
    ? result.output
    : result.output == null
      ? ""
      : JSON.stringify(result.output);
  const errorMsg = typeof result.error === "string" ? result.error : result.error ? String(result.error) : "";

  const handleCopy = async () => {
    if (!output) return;

    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <ModalCard title={result.success ? "Action Completed" : "Action Failed"} onClose={onClose}>
      {({ close }) => (
        <div className="space-y-4">
          <div
            className={`flex items-center gap-3 p-3 rounded-large-element ${
              result.success
                ? "bg-success/10 border border-success/30"
                : "bg-error/10 border border-error/30"
            }`}
          >
            {result.success ? (
              <CheckCircle className="text-success shrink-0" size={24} />
            ) : (
              <XCircle className="text-error shrink-0" size={24} />
            )}
            <div className="flex-1">
              <p className="font-mono font-medium">
                {result.success ? "Success" : "Failed"}
              </p>
              <p className="text-sm text-primary/70">
                Exit code: {exitCode ?? "N/A"}
              </p>
            </div>
            <div className="flex items-center gap-1 text-sm text-primary/60">
              <Clock size={14} />
              <span>{formatDuration(result.duration)}</span>
            </div>
          </div>

          {output && (
            <div>
              <div className="flex items-center justify-between gap-3 mb-2">
                <button
                  onClick={() => setShowVerbose(!showVerbose)}
                  className="flex items-center gap-1 text-sm text-accent hover:text-accent/80 transition-colors"
                >
                  {showVerbose ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  {showVerbose ? "Hide output" : "View output"}
                </button>

                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-pill border border-secondary/20 px-3 py-1 text-xs font-mono text-primary hover:bg-primary/5 transition-colors"
                  title="Copy output"
                >
                  {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <div
                className={`overflow-hidden motion-safe:transition-all duration-500 ease-out ${
                  showVerbose ? "max-h-96" : "max-h-0"
                }`}
              >
                <div className="bg-primary/50 border border-secondary/20 rounded-large-element p-3 mt-2">
                  <div className="max-h-80 overflow-x-auto overflow-y-auto pr-2 text-sm font-mono whitespace-pre-wrap break-all text-primary/80 select-text">
                    {output}
                  </div>
                </div>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="bg-error/5 border border-error/20 rounded-large-element p-3">
              <p className="text-sm text-error font-mono">{errorMsg}</p>
            </div>
          )}

          <button
            onClick={close}
            className="w-full px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors font-mono"
          >
            Close
          </button>
        </div>
      )}
    </ModalCard>
  );
}

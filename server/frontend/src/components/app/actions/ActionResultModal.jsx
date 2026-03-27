import { useState } from "react";
import { CheckCircle, XCircle, ChevronDown, ChevronUp, Clock, X } from "lucide-react";
import ModalCard from "../../common/cards/ModalCard";

export function ActionResultModal({ result, onClose }) {
  const [showVerbose, setShowVerbose] = useState(false);

  if (!result) return null;

  const formatDuration = (duration) => {
    if (!duration) return "N/A";
    const seconds = Math.round(duration / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  return (
    <ModalCard title={result.success ? "Action Completed" : "Action Failed"} onClose={onClose}>
      <div className="space-y-4">
        <div className={`flex items-center gap-3 p-3 rounded-large-element ${
          result.success 
            ? "bg-success/10 border border-success/30" 
            : "bg-error/10 border border-error/30"
        }`}>
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
              Exit code: {result.exit_code ?? "N/A"}
            </p>
          </div>
          <div className="flex items-center gap-1 text-sm text-primary/60">
            <Clock size={14} />
            <span>{formatDuration(result.duration)}</span>
          </div>
        </div>

        {result.output && (
          <div>
            <button
              onClick={() => setShowVerbose(!showVerbose)}
              className="flex items-center gap-1 text-sm text-accent hover:text-accent/80 transition-colors mb-2"
            >
              {showVerbose ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              {showVerbose ? "Hide output" : "View output"}
            </button>
            
            {showVerbose && (
              <div className="bg-primary/50 border border-secondary/20 rounded-large-element p-3">
                <pre className="text-sm font-mono whitespace-pre-wrap break-all text-primary/80">
                  {result.output}
                </pre>
              </div>
            )}
          </div>
        )}

        {result.error && (
          <div className="bg-error/5 border border-error/20 rounded-large-element p-3">
            <p className="text-sm text-error font-mono">{result.error}</p>
          </div>
        )}

        <button
          onClick={onClose}
          className="w-full px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors font-mono"
        >
          Close
        </button>
      </div>
    </ModalCard>
  );
}

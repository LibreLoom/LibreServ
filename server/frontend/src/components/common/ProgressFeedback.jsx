import { cn } from "@/lib/utils";
import { useState, useRef, useEffect } from "react";
import { CheckCircle, XCircle, ChevronDown, Copy, Check, Loader2 } from "lucide-react";
import { useScriptStream } from "../../hooks/useScriptStream";
import { getFriendlyMessages } from "../../utils/outputPatterns";
import { copyWithFeedback } from "../../utils/clipboard";
import { ICON_SIZE } from "@/lib/ui-tokens";

function getFullOutput(lines) {
  return lines
    .map((l) => {
      if (l.type === "stderr" && l.content) return l.content;
      if (l.type === "stdout" && l.content) return l.content;
      if (l.type === "error") return `Error: ${l.error}`;
      return "";
    })
    .filter(Boolean)
    .join("");
}

/** @param {{ streamUrl: any, title: any, onComplete: any, onError: any, patternMap?: any }} _ */
export function ProgressFeedback({
  streamUrl,
  title,
  onComplete,
  onError,
  patternMap,
}) {
  const { lines, status, exitCode, error, connect } = useScriptStream();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef(null);
  const hasConnected = useRef(false);

  useEffect(() => {
    if (streamUrl && !hasConnected.current) {
      hasConnected.current = true;
      connect(streamUrl);
    }
  }, [streamUrl, connect]);

  useEffect(() => {
    if (status === "complete") {
      onComplete?.({ exitCode });
    } else if (status === "error") {
      onError?.({ exitCode, error });
    }
  }, [status, exitCode, error, onComplete, onError]);

  useEffect(() => {
    if (outputRef.current && detailsOpen) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, detailsOpen]);

  const handleCopy = async () => {
    const output = getFullOutput(lines);
    await copyWithFeedback(output, setCopied);
  };

  const friendlyMessages = getFriendlyMessages(lines, patternMap);
  const currentMessage = friendlyMessages[friendlyMessages.length - 1];

  if (status === "complete") {
    return (
      <div className="text-center space-y-4">
        <CheckCircle className="mx-auto text-accent" size={48} />
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Done!
        </h2>
        <p className="text-accent">
          {title || "Action"} completed successfully.
        </p>
        <DetailsToggle
          detailsOpen={detailsOpen}
          setDetailsOpen={setDetailsOpen}
          copied={copied}
          onCopy={handleCopy}
          lines={lines}
          outputRef={outputRef}
        />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="text-center space-y-4">
        <XCircle className="mx-auto text-secondary" size={48} />
        <div className="space-y-2">
          <h2 className="font-mono text-2xl font-normal text-secondary">
            Something went wrong
          </h2>
          <p className="text-accent">
            {title || "Action"} couldn't be completed.
          </p>
          <p className="text-sm text-accent">
            Tap "View details" to see what happened.
          </p>
        </div>
        <DetailsToggle
          detailsOpen={detailsOpen}
          setDetailsOpen={setDetailsOpen}
          copied={copied}
          onCopy={handleCopy}
          lines={lines}
          outputRef={outputRef}
        />
      </div>
    );
  }

  return (
    <div className="text-center space-y-4">
      <Loader2 className="mx-auto text-secondary animate-spin" size={48} />
      <div className="space-y-2">
        <h2 className="font-mono text-xl font-normal text-secondary">
          {title || "Working..."}
        </h2>
        {currentMessage && (
          <p className="text-accent">{currentMessage}</p>
        )}
      </div>
      <DetailsToggle
        detailsOpen={detailsOpen}
        setDetailsOpen={setDetailsOpen}
        copied={copied}
        onCopy={handleCopy}
        lines={lines}
        outputRef={outputRef}
      />
    </div>
  );
}

function DetailsToggle({ detailsOpen, setDetailsOpen, copied, onCopy, lines, outputRef }) {
  return (
    <div className="space-y-3">
      <button
        onClick={() => setDetailsOpen((open) => !open)}
        className="inline-flex items-center gap-1 text-sm text-accent hover:text-secondary/80 transition-colors font-mono cursor-pointer"
        aria-expanded={detailsOpen}
      >
        <ChevronDown
          size={ICON_SIZE.sm}
          className={cn("motion-safe:transition-transform", detailsOpen && "rotate-180", !detailsOpen && "rotate-0")}
        />
        {detailsOpen ? "Hide details" : "View details"}
      </button>

      <div
        className={cn("overflow-hidden motion-safe:transition-all motion-safe:duration-300", detailsOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0 pointer-events-none")}
      >
        <div className="rounded-card border border-secondary/10 bg-primary/20 p-4 text-left">
          <div className="mb-3 flex items-center justify-between gap-3 border-b border-secondary/10 pb-3">
            <p className="font-mono text-sm text-secondary">Output</p>
            <button
              onClick={onCopy}
              className="flex items-center gap-1 text-xs text-accent hover:text-secondary/80 transition-colors cursor-pointer"
            >
              {copied ? (
                <>
                  <Check size={ICON_SIZE.xs} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={ICON_SIZE.xs} />
                  Copy
                </>
              )}
            </button>
          </div>
          <pre
            ref={outputRef}
            className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-accent"
          >
            {getFullOutput(lines)}
          </pre>
        </div>
      </div>
    </div>
  );
}

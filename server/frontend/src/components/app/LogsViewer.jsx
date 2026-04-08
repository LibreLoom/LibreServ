import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Loader2,
  Search,
  Terminal,
  Maximize2,
  Minimize2,
} from "lucide-react";
import ModalCard from "../cards/ModalCard";

const DEFAULT_LINE_COUNT = 500;
const LOAD_MORE_INCREMENT = 500;
const CONTROL_BUTTON_CLASS =
  "rounded-pill border border-accent bg-secondary px-4 py-2 text-sm font-mono text-primary transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";

function normaliseLines(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap((entry) => String(entry).split(/\r?\n/));
  }
  return String(input).split(/\r?\n/);
}

export default function LogsViewer({
  app,
  onClose,
}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [lines, setLines] = useState([]);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [lineLimit, setLineLimit] = useState(DEFAULT_LINE_COUNT);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasMoreToLoad, setHasMoreToLoad] = useState(false);

  const eventSourceRef = useRef(null);
  const outputRef = useRef(null);
  const isLoadingMoreRef = useRef(false);

  const streamUrl = useMemo(() => {
    if (!app?.id) return "";
    return `/api/v1/apps/${app.id}/logs/stream?tail=${lineLimit}&follow=true`;
  }, [app?.id, lineLimit]);

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  const appendChunk = useCallback((chunk) => {
    const newLines = normaliseLines(chunk);
    if (newLines.length === 0) return;
    setLines((prev) => {
      const updated = [...prev, ...newLines];
      if (updated.length > lineLimit) {
        setHasMoreToLoad(true);
        return updated.slice(-lineLimit);
      }
      return updated;
    });
  }, [lineLimit]);

  const startStream = useCallback(() => {
    if (!streamUrl) return;
    closeStream();
    setStreamError("");
    setLines([]);
    setHasMoreToLoad(false);
    setIsStreaming(true);

    const es = new EventSource(streamUrl, { withCredentials: true });
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.type === "stdout" || payload?.type === "stderr") {
          appendChunk(payload.content || "");
          return;
        }
        if (payload?.content) {
          appendChunk(payload.content);
          return;
        }
        if (payload?.error) {
          setStreamError(payload.error);
        }
      } catch {
        appendChunk(event.data);
      }
    };

    es.onerror = () => {
      setIsStreaming(false);
      setStreamError((prev) => prev || "Live log stream disconnected.");
      es.close();
      eventSourceRef.current = null;
    };
  }, [appendChunk, closeStream, streamUrl]);

  useEffect(() => {
    if (isLoadingMoreRef.current) {
      isLoadingMoreRef.current = false;
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    startStream();
  }, [startStream]);

  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

  useEffect(() => {
    if (!autoScroll || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const handleLoadMore = useCallback(() => {
    const newLimit = lineLimit + LOAD_MORE_INCREMENT;
    isLoadingMoreRef.current = true;
    setLineLimit(newLimit);
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lineLimit]);

  const filteredLines = useMemo(() => {
    if (!filter.trim()) return lines;
    const lower = filter.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(lower));
  }, [filter, lines]);

  return (
    <ModalCard
      title={
        <div className="flex items-center gap-3">
          <span>Log Viewer • {app?.name || "App"}</span>
          {isStreaming && (
            <div className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent font-sans">
              <span className="relative flex h-2 w-2 mr-1">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
              </span>
              Live Stream
            </div>
          )}
        </div>
      }
      onClose={onClose}
      size={isFullscreen ? "fullscreen" : "xl"}
    >
      <div className="flex flex-col h-full min-h-0 space-y-4 max-h-full">
        <div className="flex items-center justify-between shrink-0 gap-3">
          <div className="relative flex-1 min-w-[200px] w-full bg-secondary rounded-pill border-2 border-primary/20 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent transition-colors">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/50" />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter logs"
              className="w-full bg-transparent pl-11 pr-4 py-2 text-primary placeholder:text-primary/40 focus:outline-none font-mono text-sm"
            />
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-3 px-4 py-1.5 rounded-pill border-2 border-primary/20 bg-secondary transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
              <span className="text-sm font-mono text-primary/80">Auto Scroll</span>
              <label className="relative flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                <div className={`block w-9 h-5 rounded-full transition-colors ${autoScroll ? "bg-accent" : "bg-primary/20"}`}></div>
                <div className={`dot absolute left-1 top-1 bg-primary w-3 h-3 rounded-full transition-transform ${autoScroll ? "transform translate-x-4 bg-secondary" : ""}`}></div>
              </label>
            </div>

            <button
              type="button"
              onClick={() => setIsFullscreen((prev) => !prev)}
              className="p-2 rounded-pill border-2 border-primary/20 bg-secondary text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          </div>
        </div>

        <div className="flex flex-col flex-1 min-h-0 rounded-[12px] border border-primary/15 bg-[#1e1e1e] overflow-hidden">
          <div
            ref={outputRef}
            className="flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-6 text-gray-300 min-h-[300px]"
          >
            {filteredLines.length === 0 && streamError ? (
              <div className="py-10 text-center text-gray-500">
                Failed to load logs.
              </div>
            ) : filteredLines.length === 0 ? (
              <div className="py-10 text-center text-gray-500">
                No logs found for this app yet.
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words m-0">
                {filteredLines.map((line, i) => (
                  <div key={i} className={line.toLowerCase().includes("error") ? "text-red-400" : ""}> {/* color-scan: ignore-line dynamic error highlighting */}
                    {line}
                  </div>
                ))}
              </pre>
            )}
          </div>

          <div className="flex items-center justify-between shrink-0 border-t border-primary/15 bg-secondary/50 px-4 py-2">
            <div className="flex items-center gap-2 text-xs font-mono text-primary/60">
              <Terminal size={14} />
              <span>Showing last {lines.length} lines</span>
            </div>

            {hasMoreToLoad && !filter && (
              <button
                type="button"
                onClick={handleLoadMore}
                className="inline-flex items-center gap-1.5 rounded-pill border border-primary/20 bg-secondary px-3 py-1.5 text-xs font-mono text-primary/80 transition-colors hover:border-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ChevronDown size={14} />
                Load {LOAD_MORE_INCREMENT} more
              </button>
            )}

            {isStreaming && filteredLines.length === 0 && (
              <div className="flex items-center gap-2 text-xs font-mono text-accent">
                <Loader2 size={14} className="animate-spin" />
                <span>Streaming...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalCard>
  );
}

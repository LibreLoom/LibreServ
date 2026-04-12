import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  Download,
  Loader2,
  Search,
  Terminal,
  X,
} from "lucide-react";
import ModalCard from "../cards/ModalCard";
import Toggle from "../common/Toggle";

const DEFAULT_LINE_COUNT = 500;
const LOAD_MORE_INCREMENT = 500;
const CONTROL_BUTTON_CLASS =
  "rounded-pill border-2 border-accent bg-secondary px-4 py-2 text-sm font-sans text-primary transition-all hover:scale-105 hover:bg-accent/20 hover:border-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";
const ICON_BUTTON_CLASS =
  "p-2 rounded-pill border-2 border-primary/20 bg-secondary text-primary transition-all hover:scale-105 hover:bg-primary/10 hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

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
  const [hasMoreToLoad, setHasMoreToLoad] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const eventSourceRef = useRef(null);
  const outputRef = useRef(null);
  const searchInputRef = useRef(null);
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

  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

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

  const handleDownload = useCallback(() => {
    const text = filteredLines.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${app?.name || "app"}-logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filteredLines, app?.name]);

  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => !prev);
    if (showSearch) {
      setFilter("");
    }
  }, [showSearch]);

  return (
    <ModalCard
      title={
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="sm:hidden">Logs</span>
          <span className="hidden sm:inline">Log Viewer &bull; {app?.name || "App"}</span>
          {isStreaming && (
            <>
              <span className="sm:hidden relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
              </span>
              <div className="hidden sm:inline-flex items-center gap-1 rounded-pill border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent font-sans">
                <span className="relative flex h-2 w-2 mr-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
                </span>
                Live Stream
              </div>
            </>
          )}
        </div>
      }
      onClose={onClose}
      size="xl"
      mobileFullscreen
    >
      <div className="flex flex-col h-full min-h-0 space-y-2 sm:space-y-4 max-h-[100vh] sm:max-h-[75vh]">
        {/* Mobile toolbar */}
        <div className="flex sm:hidden items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleToggleSearch}
            className={`${ICON_BUTTON_CLASS} ${showSearch || filter ? "border-accent text-accent" : ""}`}
            aria-label="Toggle search"
          >
            <Search size={18} aria-hidden="true" />
          </button>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-pill border border-primary/20 bg-secondary">
            <ArrowDownToLine size={14} className={`shrink-0 transition-colors ${autoScroll ? "text-accent" : "text-primary/40"}`} aria-hidden="true" />
            <Toggle
              checked={autoScroll}
              onChange={setAutoScroll}
              aria-label="Auto Scroll"
              className="[&>div]:hidden"
            />
          </div>

          <button
            type="button"
            onClick={handleDownload}
            className={ICON_BUTTON_CLASS}
            aria-label="Download logs"
          >
            <Download size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Mobile collapsible search */}
        {showSearch && (
          <div className="sm:hidden shrink-0 animate-fade-in-up">
            <div className="relative bg-secondary rounded-pill border border-primary/20 focus-within:border-accent transition-colors">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-primary/50" />
              <input
                ref={searchInputRef}
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter logs"
                className="w-full bg-transparent pl-10 pr-10 py-2 text-primary placeholder:text-primary/40 focus:outline-none focus-visible:outline-none font-sans text-sm no-focus-outline"
              />
              <button
                type="button"
                onClick={handleToggleSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-primary/50 hover:text-primary transition-colors"
                aria-label="Close search"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Desktop toolbar */}
        <div className="hidden sm:flex items-center justify-between shrink-0 gap-3">
          <div className="relative flex-1 min-w-0 w-full bg-secondary rounded-pill border-2 border-primary/20 focus-within:border-accent transition-colors">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-primary/50" />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter logs"
              className="w-full bg-transparent pl-11 pr-4 py-2 text-primary placeholder:text-primary/40 focus:outline-none focus-visible:outline-none font-sans text-sm no-focus-outline"
            />
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-3 px-4 py-1.5 rounded-pill border-2 border-primary/20 bg-secondary transition-colors focus-within:border-accent">
              <Toggle
                label="Auto Scroll"
                checked={autoScroll}
                onChange={setAutoScroll}
                iconOn={ArrowDownToLine}
                iconOff={ArrowDownToLine}
                className="gap-2 [&>div]:pr-0 [&>div>div]:text-xs"
              />
            </div>

            <button
              type="button"
              onClick={handleDownload}
              className={CONTROL_BUTTON_CLASS}
              title="Download logs"
            >
              <Download size={16} className="inline -mt-0.5 mr-1.5" />
              Download
            </button>
          </div>
        </div>

        <div className="flex flex-col flex-1 min-h-0 rounded-[12px] border border-primary/15 bg-secondary/90 overflow-hidden">
          <div
            ref={outputRef}
            className="flex-1 overflow-auto px-2 sm:px-4 py-3 font-sans text-[11px] sm:text-xs leading-6 text-primary/80 min-h-[200px] sm:min-h-[300px]"
          >
            {filteredLines.length === 0 && streamError ? (
              <div className="py-10 text-center text-primary/50">
                Failed to load logs.
              </div>
            ) : filteredLines.length === 0 ? (
              <div className="py-10 text-center text-primary/50">
                No logs found for this app yet.
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-words m-0">
                {filteredLines.map((line, i) => (
                  <div key={i} className={line.toLowerCase().includes("error") ? "text-error" : ""}>
                    {line}
                  </div>
                ))}
              </pre>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between shrink-0 border-t border-primary/15 bg-secondary/50 px-3 sm:px-4 py-2">
            <div className="flex items-center gap-2 text-xs font-sans text-primary/60">
              <Terminal size={14} />
              <span>Showing last {lines.length} lines</span>
            </div>

            <div className="flex items-center gap-2">
              {hasMoreToLoad && !filter && (
                <button
                  type="button"
                  onClick={handleLoadMore}
                  className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 rounded-pill border border-primary/20 bg-secondary px-3 py-1.5 text-xs font-sans text-primary/80 transition-colors hover:border-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <ChevronDown size={14} />
                  Load {LOAD_MORE_INCREMENT} more
                </button>
              )}

              {isStreaming && filteredLines.length === 0 && (
                <div className="flex items-center gap-2 text-xs font-sans text-accent">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Streaming...</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </ModalCard>
  );
}
